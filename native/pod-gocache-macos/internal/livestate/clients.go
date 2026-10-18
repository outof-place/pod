package livestate

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"unsafe"
)

// syscall.fcntl is libc's fcntl, pushed for cmd/link (syscall/linkname_darwin.go).
//
//go:linkname fcntl syscall.fcntl
func fcntl(fd int, cmd int, arg int) (int, error)

// lockByte sets (F_SETLK) or queries (F_GETLK) a write lock on one byte.
// A query returns the holder's pid, or 0 when nobody else holds it.
func lockByte(fd, cmd int, off int64) (holder int, err error) {
	lk := syscall.Flock_t{Start: off, Len: 1, Type: syscall.F_WRLCK, Whence: 0}
	for {
		_, err = fcntl(fd, cmd, int(uintptr(unsafe.Pointer(&lk))))
		if err != syscall.EINTR {
			break
		}
	}
	runtime.KeepAlive(&lk)
	if err != nil || cmd != syscall.F_GETLK || lk.Type == syscall.F_UNLCK {
		return 0, err
	}
	return int(lk.Pid), nil
}

func slotLockOffset(i int) int64 { return int64(slotHeadersOffset + i*slotHeaderSize) }

var errBadClients = errors.New("livestate: clients file header does not match")

// validClients checks the fixed header of a mapped clients file.
func validClients(b []byte, id CacheID) bool {
	valid := false
	ok := protect(func() {
		h := region{b}
		valid = string(b[chMagic:chMagic+8]) == cliMagic && h.load(chVersion) == Version &&
			h.load(chFileSize) == clientsFileSize && h.load(chSlots) == SlotCount &&
			h.load(chSlotHeadersOffset) == slotHeadersOffset && h.load(chSlotHeaderSize) == slotHeaderSize &&
			h.load(chLogsOffset) == logsOffset && h.load(chLogRecords) == LogRecords &&
			h.load(chRecordSize) == recordSize && h.load(chDyingOffset) == dyingOffset &&
			h.load(chDyingEntries) == dyingEntries &&
			h.load(chCacheDev) == id.Dev && h.load(chCacheIno) == id.Ino
	})
	return ok && valid
}

// Clients is the daemon's side of the clients file: it writes the header and
// the dying table, and only reads the slots.
type Clients struct {
	fd      int // kept open for F_GETLK
	hdr     region
	logs    region
	gen     uint64 // activeGen as last written
	Adopted bool   // the file was already there (live clients may hold slots)
}

// OpenClients adopts dir/clients when it is valid for cache id, and otherwise
// creates a new one and renames it over whatever was there. An existing file
// is never reinitialized: clients that started before this daemon keep their
// slots and their pins. The pages the daemon writes are zero-filled up front;
// the logs stay sparse.
func OpenClients(dir string, id CacheID, boot [16]byte) (*Clients, error) {
	path := filepath.Join(dir, ClientsName)
	if c, err := adoptClients(path, id); err == nil {
		c.Adopted = true
		c.claim()
		return c, nil
	}
	tmp := filepath.Join(dir, ".clients."+strconv.Itoa(os.Getpid()))
	syscall.Unlink(tmp)
	fd, err := syscall.Open(tmp, syscall.O_RDWR|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*Clients, error) {
		syscall.Close(fd)
		syscall.Unlink(tmp)
		return nil, err
	}
	if err := syscall.Ftruncate(fd, clientsFileSize); err != nil {
		return fail(err)
	}
	if err := zeroFill(fd, 0, logsOffset); err != nil {
		return fail(err)
	}
	c, err := mapClients(fd)
	if err != nil {
		return fail(err)
	}
	ok := protect(func() {
		h := c.hdr
		copy(h.b[chMagic:], cliMagic)
		h.store(chVersion, Version)
		h.store(chFileSize, clientsFileSize)
		h.store(chSlots, SlotCount)
		h.store(chSlotHeadersOffset, slotHeadersOffset)
		h.store(chSlotHeaderSize, slotHeaderSize)
		h.store(chLogsOffset, logsOffset)
		h.store(chLogRecords, LogRecords)
		h.store(chRecordSize, recordSize)
		h.store(chDyingOffset, dyingOffset)
		h.store(chDyingEntries, dyingEntries)
		h.store(chCacheDev, id.Dev)
		h.store(chCacheIno, id.Ino)
		h.store(chCreated, uint64(AwakeNow()))
		copy(h.b[chBootID:chBootID+16], boot[:])
	})
	if !ok {
		c.Close()
		syscall.Unlink(tmp)
		return nil, errors.New("livestate: clients header write faulted")
	}
	if err := syscall.Rename(tmp, path); err != nil {
		c.Close()
		syscall.Unlink(tmp)
		return nil, err
	}
	c.claim()
	return c, nil
}

func adoptClients(path string, id CacheID) (*Clients, error) {
	fd, _, err := openChecked(path, true, clientsFileSize, clientsFileSize)
	if err != nil {
		return nil, err
	}
	c, err := mapClients(fd)
	if err != nil {
		syscall.Close(fd)
		return nil, err
	}
	if !validClients(c.hdr.b, id) {
		c.Close()
		return nil, errBadClients
	}
	return c, nil
}

func mapClients(fd int) (*Clients, error) {
	hdr, err := mapShared(fd, 0, logsOffset, true)
	if err != nil {
		return nil, err
	}
	logs, err := mapShared(fd, logsOffset, SlotCount*logSize, false)
	if err != nil {
		syscall.Munmap(hdr)
		return nil, err
	}
	return &Clients{fd: fd, hdr: region{hdr}, logs: region{logs}}, nil
}

// claim records this daemon in the header and clears any dying batch a dead
// predecessor left active.
func (c *Clients) claim() {
	protect(func() {
		c.gen = c.hdr.load(chActiveGen) | 1
		c.gen += 2
		c.hdr.store(chActiveGen, c.gen)
		c.hdr.store(chDaemonPID, uint64(os.Getpid()))
		c.hdr.store(chDaemonStart, uint64(AwakeNow()))
	})
}

// Close unmaps the file and drops the descriptor.
func (c *Clients) Close() {
	if c.hdr.b != nil {
		syscall.Munmap(c.hdr.b)
		syscall.Munmap(c.logs.b)
		syscall.Close(c.fd)
		c.hdr.b, c.logs.b = nil, nil
	}
}

// Heartbeat stamps the header with the daemon's wall clock (informational).
func (c *Clients) Heartbeat(wallNs int64) bool {
	return protect(func() { c.hdr.store(chHeartbeat, uint64(wallNs)) })
}

func dyingSlot(prefix uint64) uint64 { return mix64(prefix) & (dyingEntries - 1) }

// BeginDying marks outputs (by prefix) as about to be deleted: entries are
// written under the next even generation, then that generation is made
// active in one store. Up to MaxDying prefixes; a batch already active is
// ended first.
func (c *Clients) BeginDying(prefixes []uint64) bool {
	if len(prefixes) > MaxDying {
		return false
	}
	if c.gen&1 == 0 && !c.EndDying() {
		return false
	}
	return protect(func() {
		g := c.gen + 1
		for _, p := range prefixes {
			for k := uint64(0); k < dyingEntries; k++ {
				off := dyingOffset + int((dyingSlot(p)+k)&(dyingEntries-1))*dyingEntrySize
				if c.hdr.load(off+8) == g {
					if c.hdr.load(off) == p {
						break
					}
					continue
				}
				c.hdr.store(off, p)
				c.hdr.store(off+8, g)
				break
			}
		}
		c.hdr.store(chBatchStart, uint64(AwakeNow()))
		c.hdr.store(chActiveGen, g)
		c.gen = g
	})
}

// EndDying deactivates the current batch. Entries are only rewritten after
// this, so a client that saw a batch active saw all of it.
func (c *Clients) EndDying() bool {
	if c.gen&1 != 0 {
		return true
	}
	return protect(func() {
		c.gen++
		c.hdr.store(chActiveGen, c.gen)
	})
}

// SlotView is a snapshot of one slot header.
type SlotView struct {
	Token      uint64
	PID        int
	GoPID      int
	ClaimMono  int64
	ClaimWall  int64
	ClosedMono int64
	LogLen     uint64
	Flags      uint64
	Boot       [16]byte
	Cache      CacheID
	FastHits   uint64
	DiskHits   uint64
	Misses     uint64
	Puts       uint64
}

// Slot reads slot i's header. Token is read first: a new owner writes it
// last, so the other fields are at least as new as the token read.
func (c *Clients) Slot(i int, v *SlotView) bool {
	return protect(func() {
		o := slotHeadersOffset + i*slotHeaderSize
		h := c.hdr
		v.Token = h.load(o + shToken)
		v.PID = int(h.load(o + shPID))
		v.GoPID = int(h.load(o + shGoPID))
		v.ClaimMono = int64(h.load(o + shClaimMono))
		v.ClaimWall = int64(h.load(o + shClaimWall))
		v.ClosedMono = int64(h.load(o + shClosedMono))
		v.LogLen = h.load(o + shLogLen)
		v.Flags = h.load(o + shFlags)
		for j := range 2 {
			binary.LittleEndian.PutUint64(v.Boot[8*j:], h.load(o+shBootID+8*j))
		}
		v.Cache = CacheID{Dev: h.load(o + shCacheDev), Ino: h.load(o + shCacheIno)}
		v.FastHits, v.DiskHits = h.load(o+shFastHits), h.load(o+shDiskHits)
		v.Misses, v.Puts = h.load(o+shMisses), h.load(o+shPuts)
	})
}

// Record is one decoded log record.
type Record struct {
	Out    uint64 // output prefix
	Action uint64 // action prefix
	Kind   uint8
	Flags  uint16 // RecordRefreshed, RecordStale
	Micros uint64 // awake microseconds since the slot was claimed
	Size   int64  // as the client claims; the daemon trusts only its own index
}

// Records decodes records [from, to) of slot i into dst (appending).
func (c *Clients) Records(i int, from, to uint64, dst []Record) ([]Record, bool) {
	to = min(to, LogRecords)
	ok := protect(func() {
		base := i * logSize
		for r := from; r < to; r++ {
			o := base + int(r)*recordSize
			k := c.logs.load(o + 16)
			dst = append(dst, Record{
				Out: c.logs.load(o), Action: c.logs.load(o + 8), Kind: uint8(k),
				Flags: uint16(k & 0xff00), Micros: k >> 16, Size: int64(c.logs.load(o + 24)),
			})
		}
	})
	return dst, ok
}

// Holder is the pid holding slot i's lock, 0 when nobody does (the client
// exited or died: locks go with the process).
func (c *Clients) Holder(i int) (int, error) {
	return lockByte(c.fd, syscall.F_GETLK, slotLockOffset(i))
}

// Slot is a client's claimed slot.
type Slot struct {
	fd        int // holds the lock; closing any descriptor of the file drops it
	hdr       region
	log       region
	off       int // this slot's header offset in hdr
	n         uint64
	claimMono int64
	seen      prefixSet
	overflow  bool
}

// ClaimSlot maps dir/clients when it is valid for cache id and claims a free
// slot. It never blocks: a slot another live process holds is skipped.
func ClaimSlot(dir string, id CacheID, boot [16]byte, goPID int) (*Slot, error) {
	fd, _, err := openChecked(filepath.Join(dir, ClientsName), true, clientsFileSize, clientsFileSize)
	if err != nil {
		return nil, err
	}
	hdr, err := mapShared(fd, 0, logsOffset, true)
	if err != nil {
		syscall.Close(fd)
		return nil, err
	}
	fail := func(err error) (*Slot, error) {
		syscall.Munmap(hdr)
		syscall.Close(fd)
		return nil, err
	}
	if !validClients(hdr, id) {
		return fail(errBadClients)
	}
	pid := os.Getpid()
	slot := -1
	for k := range SlotCount {
		i := (pid + k) % SlotCount
		if _, err := lockByte(fd, syscall.F_SETLK, slotLockOffset(i)); err == nil {
			slot = i
			break
		}
	}
	if slot < 0 {
		return fail(ErrNoSlot)
	}
	log, err := mapShared(fd, int64(logsOffset+slot*logSize), logSize, true)
	if err != nil {
		return fail(err)
	}
	var tok [8]byte
	rand.Read(tok[:])
	s := &Slot{fd: fd, hdr: region{hdr}, log: region{log}, off: slotHeadersOffset + slot*slotHeaderSize, claimMono: AwakeNow()}
	ok := protect(func() {
		h, o := s.hdr, s.off
		h.store(o+shLogLen, 0)
		h.store(o+shClosedMono, 0)
		h.store(o+shFlags, 0)
		h.store(o+shPID, uint64(pid))
		h.store(o+shGoPID, uint64(goPID))
		h.store(o+shClaimMono, uint64(s.claimMono))
		h.store(o+shClaimWall, uint64(wallNow()))
		h.store(o+shBootID, binary.LittleEndian.Uint64(boot[0:]))
		h.store(o+shBootID+8, binary.LittleEndian.Uint64(boot[8:]))
		h.store(o+shCacheDev, id.Dev)
		h.store(o+shCacheIno, id.Ino)
		for _, f := range []int{shFastHits, shDiskHits, shMisses, shPuts} {
			h.store(o+f, 0)
		}
		h.store(o+shToken, binary.LittleEndian.Uint64(tok[:])|1)
	})
	if !ok {
		syscall.Munmap(log)
		return fail(errors.New("livestate: slot header write faulted"))
	}
	return s, nil
}

// ErrNoSlot means every slot is held by a live process.
var ErrNoSlot = errors.New("livestate: no free client slot")

// Pin records that out is handed to go (a hit, or a put's output) and then
// reports whether the daemon is deleting it right now. The record is
// published before the dying table is read, and the daemon activates a batch
// before it reads the logs, so either the daemon sees the pin or the client
// sees the batch. A hit whose output is dying must be answered as a miss.
// Call inside protect.
func (s *Slot) Pin(out, action *[32]byte, kind uint64, size int64) (dying bool) {
	p := Prefix(out)
	if s.seen.add(p) || kind&0xff >= KindPutStored || kind&0xff00 != 0 {
		s.append(p, Prefix(action), kind&0xffff, size)
	}
	return s.Dying(p)
}

// Dying reports whether the output with prefix p is in the active dying
// batch, unless that batch is older than BatchLife (or from another boot).
// Call inside protect.
func (s *Slot) Dying(p uint64) bool {
	g := s.hdr.load(chActiveGen)
	if g&1 != 0 {
		return false
	}
	for k := uint64(0); k < dyingEntries; k++ {
		off := dyingOffset + int((dyingSlot(p)+k)&(dyingEntries-1))*dyingEntrySize
		if s.hdr.load(off+8) != g {
			return false
		}
		if s.hdr.load(off) == p {
			age := AwakeNow() - int64(s.hdr.load(chBatchStart))
			return age >= 0 && age < int64(BatchLife)
		}
	}
	return false
}

func (s *Slot) append(out, action, kind uint64, size int64) {
	if s.n >= LogRecords {
		if !s.overflow {
			s.overflow = true
			s.hdr.store(s.off+shFlags, FlagOverflow)
		}
		return
	}
	o := int(s.n) * recordSize
	micros := uint64(max(0, AwakeNow()-s.claimMono)) / 1000
	s.log.store(o, out)
	s.log.store(o+8, action)
	s.log.store(o+16, kind|micros<<16)
	s.log.store(o+24, uint64(size))
	s.n++
	s.hdr.store(s.off+shLogLen, s.n)
}

// Count bumps one of the slot's informational counters.
func (s *Slot) Count(field int) { s.hdr.store(s.off+field, s.hdr.load(s.off+field)+1) }

// Counter fields for Count.
const (
	CountFastHit = shFastHits
	CountDiskHit = shDiskHits
	CountMiss    = shMisses
	CountPut     = shPuts
)

// Close marks the slot closed; the lock goes when the process exits.
func (s *Slot) Close() {
	protect(func() { s.hdr.store(s.off+shClosedMono, uint64(max(1, AwakeNow()))) })
}

// Overflowed reports whether the log filled up.
func (s *Slot) Overflowed() bool { return s.overflow }

// prefixSet is an open-addressing set of output prefixes this client has
// already logged; a prefix of 0 is tracked apart.
type prefixSet struct {
	keys []uint64
	n    int
	zero bool
}

// add reports whether p was new.
func (s *prefixSet) add(p uint64) bool {
	if p == 0 {
		if s.zero {
			return false
		}
		s.zero = true
		return true
	}
	if s.n*10 >= len(s.keys)*6 {
		s.grow()
	}
	mask := uint64(len(s.keys) - 1)
	for i := mix64(p) & mask; ; i = (i + 1) & mask {
		switch s.keys[i] {
		case p:
			return false
		case 0:
			s.keys[i] = p
			s.n++
			return true
		}
	}
}

func (s *prefixSet) grow() {
	old := s.keys
	s.keys = make([]uint64, max(4096, 2*len(old)))
	s.n = 0
	for _, k := range old {
		if k != 0 {
			s.add(k)
		}
	}
}
