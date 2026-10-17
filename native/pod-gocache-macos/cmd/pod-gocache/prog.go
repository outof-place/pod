package main

import (
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/protocol"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/store"
	"github.com/outof-place/pod/native/pod-gocache-macos/internal/trace"
)

const readBufSize = 256 << 10

// runProg serves the go command until close or the end of its input. It
// never exits early on its own: go treats that as fatal (cache/prog.go).
func runProg() int {
	// Like the go command, survive the terminal's interrupt so go can finish
	// and close us; a broken stdout is an error to handle, not a signal.
	signal.Ignore(syscall.SIGINT, syscall.SIGQUIT, syscall.SIGPIPE)

	w := protocol.NewWriter(os.Stdout)
	w.Hello()
	w.Flush()

	st := store.Open(storeDir())
	var tr *trace.Recorder
	if !killSwitch() {
		tr = openTrace()
	}
	closed := serve(os.Stdin, w, st, tr)

	// go waits for stdout to close, not for exit: release it before cleanup.
	os.Stdout.Close()
	end := trace.OpEOF
	if closed {
		end = trace.OpClose
	}
	tr.Close(end)
	return 0
}

// storeDir resolves the store like cmd/go/internal/cache.DefaultDir. go sets
// GOCACHE to its effective value for subprocesses (cmd/go/main.go), so the
// fallback to the default location only matters when run by hand.
func storeDir() string {
	dir := os.Getenv("GOCACHE")
	if dir == "" {
		ucd, err := os.UserCacheDir()
		if err != nil {
			return ""
		}
		return filepath.Join(ucd, "go-build")
	}
	if dir == "off" || !filepath.IsAbs(dir) {
		return ""
	}
	return dir
}

// killSwitch reports whether ~/.pod/gocache/disabled exists. It is the
// rollback for terminals whose environment already holds GOCACHEPROG: the
// client then serves as a plain native-layout disk cache, with no trace and no
// daemon contact.
func killSwitch() bool {
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Join(home, ".pod", "gocache", "disabled"))
	return err == nil
}

func openTrace() *trace.Recorder {
	if os.Getenv("POD_GOCACHE_TRACE") == "off" {
		return nil
	}
	dir := os.Getenv("POD_GOCACHE_TRACE_DIR")
	if dir == "" {
		var err error
		if dir, err = trace.DefaultDir(); err != nil {
			return nil
		}
	}
	return trace.New(dir)
}

// serve answers requests in arrival order. It reports whether the session
// ended with a close request.
func serve(in io.Reader, w *protocol.Writer, st *store.Store, tr *trace.Recorder) bool {
	r := protocol.NewReader(in, readBufSize, w.Flush)
	var (
		req protocol.Request
		hit store.Hit
		put store.PutResult
	)
	for {
		if err := r.Next(&req); err != nil {
			return false
		}
		start := time.Now()
		switch req.Command {
		case protocol.CmdGet:
			if req.HasActionID && st.Get(&req.ActionID, &hit) {
				w.Hit(req.ID, &hit.OutputID, hit.Size, hit.Time, hit.DiskPath())
				tr.Record(trace.OpGetHit, &req.ActionID, &hit.OutputID, hit.Size, time.Since(start))
			} else {
				w.Miss(req.ID)
				tr.Record(trace.OpGetMiss, &req.ActionID, nil, 0, time.Since(start))
			}
		case protocol.CmdPut:
			w.Flush() // queued get replies must not wait for this put's hashing or disk
			valid := req.HasActionID && req.HasOutputID
			if err := st.Put(&req.ActionID, &req.OutputID, valid, req.BodySize, r.Body(), &put); err != nil {
				w.Error(req.ID, err.Error())
				tr.Record(trace.OpPutFailed, &req.ActionID, &req.OutputID, req.BodySize, time.Since(start))
			} else {
				w.Put(req.ID, put.DiskPath())
				tr.Record(putOp(put.Outcome), &req.ActionID, &req.OutputID, req.BodySize, time.Since(start))
			}
		case protocol.CmdClose:
			w.Done(req.ID)
			w.Flush()
			return true
		default:
			w.Error(req.ID, "pod-gocache: unknown command")
		}
		if w.Err() != nil {
			return false
		}
	}
}

func putOp(o store.Outcome) trace.Op {
	if o == store.Existing {
		return trace.OpPutExisting
	}
	return trace.OpPutStored
}
