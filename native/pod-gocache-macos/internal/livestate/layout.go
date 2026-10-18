// Package livestate is the state a pod-gocache daemon and its clients share
// through two memory-mapped files in a per-cache directory:
//
//   - index: the daemon's published picture of every -a entry (action ID ->
//     output ID, size, time, and the -a file's inode and ctime when the
//     daemon read it). Clients map it read-only. A client serves an entry
//     only after a stat of the -a file still shows that inode and ctime, so
//     what it serves is what reading the -a file would return now; anything
//     else falls back to reading the file.
//   - clients: a fixed table of client slots. A client claims a slot with a
//     byte-range lock that dies with the process, and appends to its slot's
//     log every output it hands to go (its pins) and every put. The daemon
//     reads the logs; it never writes a slot. The daemon writes the header
//     and the dying table, which carries the outputs it is about to delete.
//
// Every 64-bit field has exactly one writer and is read and written with
// sync/atomic (LDAR/STLR on arm64, sequentially consistent). A layout change
// is a new Version, a new directory name and new magic: files are never
// reinterpreted, and old and new processes simply do not see each other's.
package livestate

import "time"

// Version is the layout version, part of the live directory's name.
const Version = 1

const pageSize = 16384

// Directory and file names. The live directory for a cache is
// <root>/v1-<dev hex>-<ino hex>, keyed by the identity of the cache
// directory, so every spelling of one cache (symlinks, trailing slashes)
// shares it and no other cache ever does.
const (
	dirPrefix         = "v1-"
	IndexName         = "index"
	ClientsName       = "clients"
	PublisherLockName = "publisher.lock"
)

// Index file: a header page, then a power-of-two table of 128-byte slots
// (one cache line on Apple silicon), linear probing from a seeded hash of the
// whole action ID.
const (
	idxMagic      = "PODGCIDX"
	idxHeaderSize = pageSize
	idxSlotSize   = 128
	idxMinSlots   = 1 << 12
	idxMaxSlots   = 1 << 22 // 512 MiB: anything larger is not ours
	maxProbe      = 64
	readTries     = 4 // seqlock retries on one slot before giving up on the lookup
)

// Index header fields (byte offsets). All are written before the file is
// renamed into place, except superseded and live.
const (
	ihMagic      = 0
	ihVersion    = 8
	ihHeaderSize = 16
	ihFileSize   = 24
	ihSlots      = 32
	ihSlotSize   = 40
	ihCacheDev   = 48
	ihCacheIno   = 56
	ihSeed       = 64
	ihGeneration = 72
	ihDaemonPID  = 80
	ihCreated    = 88
	ihSuperseded = 96  // set once a newer index replaced this one
	ihLive       = 104 // live entries, informational
	ihBootID     = 112 // 16 bytes
)

// Index slot words. seq is 0 for a slot never written (the end of a probe
// chain), odd while the daemon rewrites it, even otherwise.
const (
	isSeq    = 0
	isState  = 1
	isAction = 2 // 4 words
	isOutput = 6 // 4 words
	isSize   = 10
	isTime   = 11
	isIno    = 12 // the -a file's inode when the daemon read it
	isCtime  = 13 // and its ctime (ns): any change to the file changes it
	isMtime  = 14 // informational
)

const (
	slotEmpty   = 0
	slotLive    = 1
	slotDeleted = 2
)

// Clients file: header page, dying table, slot headers, then one log per
// slot. The size never changes; a new geometry is a new Version.
const (
	cliMagic          = "PODGCCLI"
	cliHeaderSize     = pageSize
	dyingOffset       = pageSize
	dyingEntries      = 2048
	dyingEntrySize    = 16 // prefix, generation
	slotHeadersOffset = 3 * pageSize
	SlotCount         = 256
	slotHeaderSize    = 256
	logsOffset        = 8 * pageSize
	LogRecords        = 1 << 16 // a cold `go test ./...` of charter-service logs about 15k
	recordSize        = 32
	logSize           = LogRecords * recordSize
	clientsFileSize   = logsOffset + SlotCount*logSize
	// MaxDying is how many outputs one deletion batch may mark.
	MaxDying = dyingEntries / 2
)

// BatchLife bounds a dying batch: clients ignore one older than this (its
// daemon is stopped or gone), and the daemon unlinks nothing in a batch older
// than half of it.
const BatchLife = time.Minute

// Clients header fields (byte offsets). The first block is fixed at
// creation; the daemon that adopts the file writes the rest.
const (
	chMagic             = 0
	chVersion           = 8
	chFileSize          = 16
	chSlots             = 24
	chSlotHeadersOffset = 32
	chSlotHeaderSize    = 40
	chLogsOffset        = 48
	chLogRecords        = 56
	chRecordSize        = 64
	chDyingOffset       = 72
	chDyingEntries      = 80
	chCacheDev          = 88
	chCacheIno          = 96
	chCreated           = 104
	chBootID            = 112 // 16 bytes
	chDaemonPID         = 128
	chDaemonStart       = 136
	chHeartbeat         = 144 // wall ns, informational
	chActiveGen         = 152 // even: that dying batch is active; odd: none
	chBatchStart        = 160 // awake-clock ns when the active batch began
	chDaemonBoot        = 168 // 16 bytes: the adopting daemon's boot; zero from a daemon before it
)

// Slot header fields (byte offsets within the 256-byte header). Only the
// client holding the slot's lock writes them; token is written last.
const (
	shToken      = 0 // nonzero once claimed; new for every claim
	shPID        = 8
	shGoPID      = 16 // the go process that started the client
	shClaimMono  = 24 // awake-clock ns at claim (same clock in every process)
	shClaimWall  = 32
	shClosedMono = 40 // awake-clock ns at close, 0 while serving
	shLogLen     = 48 // records published
	shFlags      = 56
	shBootID     = 64 // 16 bytes
	shCacheDev   = 80
	shCacheIno   = 88
	shFastHits   = 96 // counters, informational
	shDiskHits   = 104
	shMisses     = 112
	shPuts       = 120
	shReason     = 128 // why the session goes without the index: Reason+1, 0 not reported
)

// Slot flags.
const (
	FlagOverflow = 1 << 0 // the log filled up: later outputs are not pinned
)

// Record kinds (low byte of record word 2). Every record pins its output.
// Hits are logged once per output and session unless flagged; puts always.
const (
	KindHitFast     = 1 // a get served from the index
	KindHitDisk     = 2 // a get served by reading the -a file
	KindPutStored   = 3 // the output was written, then the -a: the daemon re-reads it
	KindPutExisting = 4 // an existing output was reused, then the -a written
	KindPutPin      = 5 // a put's pin, taken before it reuses or replaces an existing output
)

// Record flags (bits 8 to 15 of record word 2): the daemon re-reads the -a.
const (
	RecordRefreshed = 1 << 8 // the client just refreshed the -a mtime (Go's markUsed)
	RecordStale     = 1 << 9 // the index did not have the -a as it is on disk
)
