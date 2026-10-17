package store

import (
	"encoding/hex"
)

// The index entry format and its checks mirror cmd/go/internal/cache
// (cache.go, BSD-licensed, Copyright 2017 The Go Authors):
//
//	"v1 <hex id> <hex out> <decimal size space-padded to 20> <unixnano space-padded to 20>\n"
const (
	hashSize  = 32
	hexSize   = hashSize * 2
	entrySize = 2 + 1 + hexSize + 1 + hexSize + 1 + 20 + 1 + 20 + 1
)

type entry struct {
	out  [hashSize]byte
	size int64
	time int64 // unix nanoseconds
}

// parseEntry accepts exactly what (*DiskCache).get accepts. data is what was
// read with a buffer of entrySize+1 bytes.
func parseEntry(data []byte, id *[hashSize]byte) (entry, bool) {
	var e entry
	if len(data) != entrySize {
		return e, false
	}
	if data[0] != 'v' || data[1] != '1' || data[2] != ' ' || data[3+hexSize] != ' ' || data[3+hexSize+1+hexSize] != ' ' || data[3+hexSize+1+hexSize+1+20] != ' ' || data[entrySize-1] != '\n' {
		return e, false
	}
	eid, rest := data[3:3+hexSize], data[3+hexSize:]
	eout, rest := rest[1:1+hexSize], rest[1+hexSize:]
	esize, rest := rest[1:1+20], rest[1+20:]
	etime := rest[1 : 1+20]
	var buf [hashSize]byte
	if _, err := hex.Decode(buf[:], eid); err != nil || buf != *id {
		return e, false
	}
	if _, err := hex.Decode(e.out[:], eout); err != nil {
		return e, false
	}
	var ok bool
	if e.size, ok = parsePadded(esize); !ok || e.size < 0 {
		return e, false
	}
	if e.time, ok = parsePadded(etime); !ok || e.time < 0 {
		return e, false
	}
	return e, true
}

// parsePadded skips leading spaces and then parses like
// strconv.ParseInt(s, 10, 64): optional sign, at least one digit, no other bytes.
func parsePadded(s []byte) (int64, bool) {
	i := 0
	for i < len(s) && s[i] == ' ' {
		i++
	}
	s = s[i:]
	neg := false
	if len(s) > 0 && (s[0] == '+' || s[0] == '-') {
		neg = s[0] == '-'
		s = s[1:]
	}
	if len(s) == 0 {
		return 0, false
	}
	var u uint64
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, false
		}
		if u > (1<<63)/10 {
			return 0, false
		}
		u = u*10 + uint64(c-'0')
		if u > 1<<63 {
			return 0, false
		}
	}
	if !neg && u == 1<<63 {
		return 0, false
	}
	v := int64(u)
	if neg {
		v = -v
	}
	return v, true
}

// formatEntry renders the entry exactly as putIndexEntry's
// fmt.Sprintf("v1 %x %x %20d %20d\n", ...) does.
func formatEntry(dst *[entrySize]byte, id, out *[hashSize]byte, size, unixNano int64) {
	b := dst[:0]
	b = append(b, "v1 "...)
	b = hex.AppendEncode(b, id[:])
	b = append(b, ' ')
	b = hex.AppendEncode(b, out[:])
	b = append(b, ' ')
	b = appendPadded(b, size)
	b = append(b, ' ')
	b = appendPadded(b, unixNano)
	_ = append(b, '\n')
}

// appendPadded appends v right-aligned in 20 bytes, like %20d.
func appendPadded(b []byte, v int64) []byte {
	var digits [20]byte
	i := len(digits)
	u := uint64(v)
	if v < 0 {
		u = uint64(-v)
	}
	for {
		i--
		digits[i] = byte('0' + u%10)
		u /= 10
		if u == 0 {
			break
		}
	}
	if v < 0 {
		i--
		digits[i] = '-'
	}
	for range i {
		b = append(b, ' ')
	}
	return append(b, digits[i:]...)
}
