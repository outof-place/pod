package store

import (
	"crypto/sha256"
	"errors"
	"hash"
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/livestate"
)

// Body is a put body: decoded bytes, exactly the announced size, then io.EOF.
type Body interface {
	io.Reader
	// Discard skips the rest of the body without decoding it.
	Discard() error
}

// Outcome says how a put landed.
type Outcome uint8

const (
	Stored   Outcome = iota + 1 // the output file was written
	Existing                    // the output file was already there and verified
)

// PutResult is a successful put. DiskPath points into the result.
type PutResult struct {
	Outcome Outcome
	path    pathBuf
}

// DiskPath is the output file; valid until the result is reused.
func (r *PutResult) DiskPath() []byte { return r.path.bytes() }

// File errors are reported as the built-in cache reports them ("open <output
// file>: permission denied"), so go prints the same message either way.
var (
	// ErrHashMismatch means the body does not hash to its OutputID.
	ErrHashMismatch = errors.New("pod-gocache: put body does not match its OutputID")
	errBadRequest   = errors.New("pod-gocache: put without a 32-byte ActionID and OutputID")
	errNoStore      = errors.New("pod-gocache: no usable GOCACHE directory")
	errNotFile      = errors.New("pod-gocache: output entry is not a regular file")
)

func pathErr(op, path string, err error) error {
	return &os.PathError{Op: op, Path: path, Err: err}
}

// TempPrefix names in-progress output files in a bucket. Built-in trims only
// remove names ending in -a or -d, so a later sweep must match this prefix.
const TempPrefix = ".pgc-tmp."

// ParseTempName accepts a client temp file name, ".pgc-tmp.<pid>.<seq>" with
// decimal parts, and returns its parts.
func ParseTempName(name string) (pid, seq uint64, ok bool) {
	rest, found := strings.CutPrefix(name, TempPrefix)
	if !found {
		return 0, 0, false
	}
	p, q, found := strings.Cut(rest, ".")
	if !found {
		return 0, 0, false
	}
	pid, err := strconv.ParseUint(p, 10, 32)
	if err != nil {
		return 0, 0, false
	}
	seq, err = strconv.ParseUint(q, 10, 64)
	if err != nil {
		return 0, 0, false
	}
	return pid, seq, true
}

const putBufSize = 1 << 20

// Put stores a body under id like (*DiskCache).put: the output file named by
// its hash, then the index entry. The output goes to a temp file in its bucket
// and is renamed into place only after its hash checks out, so no process
// ever sees a partial output file. On any failure nothing new is left in the
// store and the error is returned for the go command to handle, as it handles
// the built-in cache's put errors. The body is always consumed.
func (s *Store) Put(id, out *[hashSize]byte, valid bool, size int64, body Body, res *PutResult) error {
	err := s.put(id, out, valid, size, body, res)
	if s.live != nil {
		if err == nil {
			s.live.Puts++
		}
		s.live.Note()
	}
	return err
}

func (s *Store) put(id, out *[hashSize]byte, valid bool, size int64, body Body, res *PutResult) error {
	switch {
	case !valid || size < 0:
		body.Discard()
		return errBadRequest
	case s.dir == "":
		body.Discard()
		return errNoStore
	}
	if s.buf == nil {
		s.buf = make([]byte, putBufSize)
	}
	s.entryPath(&res.path, out, 'd')
	dpath := string(res.path.bytes()) // a copy: os.Open keeps the name
	var st syscall.Stat_t
	dying := false
	if statRetry(dpath, &st) == nil {
		switch st.Mode & syscall.S_IFMT {
		case syscall.S_IFREG:
			// Pin before deciding about an existing output: either the daemon
			// sees the pin, or the output shows up here as dying and is written
			// again instead of reused.
			dying = s.live != nil && s.live.Pin(out, id, livestate.KindPutPin, size)
			// copyFile's rule: reuse an existing output only after its hash
			// checks out; the built-in writes -d in place, so a size match alone
			// can be a half-written file.
			if !dying && st.Size == size && s.fileHashIs(dpath, size, out) {
				if err := body.Discard(); err != nil {
					return err
				}
				res.Outcome = Existing
				return s.entryWritten(id, out, size, livestate.KindPutExisting)
			}
		default:
			body.Discard()
			return errNotFile
		}
	}
	if err := s.writeOutput(out, size, body, dpath, dying); err != nil {
		return err
	}
	res.Outcome = Stored
	return s.entryWritten(id, out, size, livestate.KindPutStored)
}

// entryWritten writes the index entry and then tells the daemon, which
// re-reads the -a file.
func (s *Store) entryWritten(id, out *[hashSize]byte, size int64, kind uint64) error {
	if err := s.writeEntry(id, out, size, time.Now().UnixNano()); err != nil {
		return err
	}
	if s.live != nil {
		s.live.Pin(out, id, kind, size)
	}
	return nil
}

// writeOutput streams the body into a temp file next to dpath, checks its
// hash and puts it in place.
func (s *Store) writeOutput(out *[hashSize]byte, size int64, body Body, dpath string, dying bool) error {
	var tp pathBuf
	fd, err := s.createTemp(&tp, out)
	if err != nil {
		body.Discard()
		return pathErr("open", dpath, err)
	}
	tmp := string(tp.bytes())
	fail := func(err error) error {
		if fd >= 0 {
			syscall.Close(fd)
		}
		syscall.Unlink(tmp)
		return err
	}
	h := sha256.New()
	var off int64
	var werr error
	for {
		n, rerr := body.Read(s.buf)
		if n > 0 {
			h.Write(s.buf[:n])
			if werr == nil {
				werr = pwriteFull(fd, s.buf[:n], off)
				off += int64(n)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return fail(rerr)
		}
	}
	switch {
	case werr != nil:
		return fail(pathErr("write", dpath, werr))
	case off != size:
		return fail(io.ErrShortWrite)
	case !hashIs(h, out):
		return fail(ErrHashMismatch)
	}
	err = closeRetry(fd)
	fd = -1
	if err != nil {
		return fail(pathErr("close", dpath, err))
	}
	if dying {
		s.live.DyingPuts++
		if s.placeBesideDying(tmp, dpath, out) {
			return nil
		}
	}
	if err := syscall.Rename(tmp, dpath); err != nil {
		return fail(pathErr("rename", dpath, err))
	}
	return nil
}

// placeBesideDying puts tmp at dpath while the daemon may be deleting the old
// output there. A rename could land between the daemon's last check of the
// old file and its unlink, so link (create only if absent) is tried until the
// daemon's unlink is done or its batch ends, within the session's wait
// budget. It reports false when the caller should rename after all.
func (s *Store) placeBesideDying(tmp, dpath string, out *[hashSize]byte) bool {
	for {
		err := syscall.Link(tmp, dpath)
		if err == nil {
			syscall.Unlink(tmp)
			return true
		}
		if err != syscall.EEXIST || !s.live.Dying(out) || !s.live.Nap(200*time.Microsecond) {
			return false
		}
	}
}

// createTemp opens a new temp file in out's bucket, creating the bucket if a
// cleanup removed it.
func (s *Store) createTemp(p *pathBuf, out *[hashSize]byte) (int, error) {
	var lastErr error
	for range 8 {
		s.bucketPath(p, out)
		n := p.n
		name := append(p.b[n:n], '/')
		name = append(name, TempPrefix...)
		name = strconv.AppendInt(name, int64(s.pid), 10)
		name = append(name, '.')
		name = strconv.AppendUint(name, s.seq.Add(1), 10)
		p.n = n + len(name)
		fd, err := openRetry(p.str(), syscall.O_RDWR|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC, 0o666)
		switch err {
		case nil:
			return fd, nil
		case syscall.EEXIST:
			lastErr = err
		case syscall.ENOENT:
			lastErr = err
			var bp pathBuf
			if mkErr := syscall.Mkdir(s.bucketPath(&bp, out), 0o777); mkErr != nil && mkErr != syscall.EEXIST {
				return -1, mkErr
			}
		default:
			return -1, err
		}
	}
	return -1, lastErr
}

// writeEntry writes the index entry like putIndexEntry: in place, truncating
// only after the write so rewriting an entry never even briefly empties it.
func (s *Store) writeEntry(id, out *[hashSize]byte, size, unixNano int64) error {
	var line [entrySize]byte
	formatEntry(&line, id, out, size, unixNano)
	var ap pathBuf
	apath := s.entryPath(&ap, id, 'a')
	fd, err := openRetry(apath, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_CLOEXEC, 0o666)
	if err == syscall.ENOENT {
		var bp pathBuf
		syscall.Mkdir(s.bucketPath(&bp, id), 0o777)
		fd, err = openRetry(apath, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_CLOEXEC, 0o666)
	}
	if err != nil {
		return pathErr("open", strings.Clone(apath), err)
	}
	if err = pwriteFull(fd, line[:], 0); err != nil {
		err = pathErr("write", strings.Clone(apath), err)
	} else if err = syscall.Ftruncate(fd, entrySize); err != nil {
		err = pathErr("truncate", strings.Clone(apath), err)
	}
	if cerr := closeRetry(fd); err == nil && cerr != nil {
		err = pathErr("close", strings.Clone(apath), cerr)
	}
	if err != nil {
		syscall.Unlink(apath)
	}
	return err
}

// fileHashIs reports whether the file at path has size bytes hashing to out.
func (s *Store) fileHashIs(path string, size int64, out *[hashSize]byte) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.CopyBuffer(h, f, s.buf)
	return err == nil && n == size && hashIs(h, out)
}

func hashIs(h hash.Hash, out *[hashSize]byte) bool {
	var sum [hashSize]byte
	h.Sum(sum[:0])
	return sum == *out
}

func pwriteFull(fd int, buf []byte, off int64) error {
	for len(buf) > 0 {
		m, err := syscall.Pwrite(fd, buf, off)
		if err == syscall.EINTR {
			continue
		}
		if err != nil {
			return err
		}
		if m == 0 {
			return io.ErrShortWrite
		}
		buf, off = buf[m:], off+int64(m)
	}
	return nil
}

func closeRetry(fd int) error {
	err := syscall.Close(fd)
	if err == syscall.EINTR {
		return nil
	}
	return err
}
