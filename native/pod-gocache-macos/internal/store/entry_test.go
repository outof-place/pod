package store

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strconv"
	"testing"
)

// goParse is the parsing half of (*DiskCache).get from Go 1.27.2
// cmd/go/internal/cache/cache.go (BSD-licensed, Copyright 2017 The Go
// Authors), kept verbatim apart from the I/O, as the oracle for parseEntry.
func goParse(f io.Reader, id [hashSize]byte) (out [hashSize]byte, size, tm int64, err error) {
	missing := func(reason error) ([hashSize]byte, int64, int64, error) { return out, 0, 0, reason }
	entry := make([]byte, entrySize+1) // +1 to detect whether f is too long
	if n, err := io.ReadFull(f, entry); n > entrySize {
		return missing(errors.New("too long"))
	} else if err != io.ErrUnexpectedEOF {
		if err == io.EOF {
			return missing(errors.New("file is empty"))
		}
		return missing(err)
	} else if n < entrySize {
		return missing(errors.New("entry file incomplete"))
	}
	if entry[0] != 'v' || entry[1] != '1' || entry[2] != ' ' || entry[3+hexSize] != ' ' || entry[3+hexSize+1+hexSize] != ' ' || entry[3+hexSize+1+hexSize+1+20] != ' ' || entry[entrySize-1] != '\n' {
		return missing(errors.New("invalid header"))
	}
	eid, entry := entry[3:3+hexSize], entry[3+hexSize:]
	eout, entry := entry[1:1+hexSize], entry[1+hexSize:]
	esize, entry := entry[1:1+20], entry[1+20:]
	etime := entry[1 : 1+20]
	var buf [hashSize]byte
	if _, err := hex.Decode(buf[:], eid); err != nil {
		return missing(fmt.Errorf("decoding ID: %v", err))
	} else if buf != id {
		return missing(errors.New("mismatched ID"))
	}
	if _, err := hex.Decode(buf[:], eout); err != nil {
		return missing(fmt.Errorf("decoding output ID: %v", err))
	}
	i := 0
	for i < len(esize) && esize[i] == ' ' {
		i++
	}
	size, err = strconv.ParseInt(string(esize[i:]), 10, 64)
	if err != nil {
		return missing(fmt.Errorf("parsing size: %v", err))
	} else if size < 0 {
		return missing(errors.New("negative size"))
	}
	i = 0
	for i < len(etime) && etime[i] == ' ' {
		i++
	}
	tm, err = strconv.ParseInt(string(etime[i:]), 10, 64)
	if err != nil {
		return missing(fmt.Errorf("parsing timestamp: %v", err))
	} else if tm < 0 {
		return missing(errors.New("negative timestamp"))
	}
	return buf, size, tm, nil
}

// goFormat is putIndexEntry's format string.
func goFormat(id, out [hashSize]byte, size, tm int64) string {
	return fmt.Sprintf("v1 %x %x %20d %20d\n", id, out, size, tm)
}

func testID(b byte) [hashSize]byte {
	var id [hashSize]byte
	for i := range id {
		id[i] = b + byte(i)
	}
	return id
}

func TestFormatEntryMatchesGo(t *testing.T) {
	id, out := testID(1), testID(0xf0)
	for _, c := range []struct{ size, tm int64 }{
		{0, 0}, {1, 1}, {142, 1792245446101594250}, {1<<63 - 1, 1<<63 - 1}, {252_000_000, 1},
	} {
		var got [entrySize]byte
		formatEntry(&got, &id, &out, c.size, c.tm)
		if want := goFormat(id, out, c.size, c.tm); string(got[:]) != want {
			t.Errorf("size %d time %d:\n got %q\nwant %q", c.size, c.tm, got, want)
		}
	}
}

// read simulates reading an entry file with the client's entrySize+1 buffer.
func read(data []byte) []byte {
	if len(data) > entrySize+1 {
		return data[:entrySize+1]
	}
	return data
}

func FuzzParseEntryMatchesGo(f *testing.F) {
	id, out := testID(1), testID(0xf0)
	good := goFormat(id, out, 142, 1792245446101594250)
	f.Add([]byte(good))
	f.Add([]byte(good + "x"))
	f.Add([]byte(good[:len(good)-1]))
	f.Add([]byte(""))
	for _, field := range []string{"                  -0", "                  +5", "                   -", "12                  ", "                    ", "-9223372036854775808", " 9223372036854775808"} {
		f.Add([]byte(good[:3+hexSize+1+hexSize+1] + field + good[3+hexSize+1+hexSize+1+20:]))
	}
	f.Add([]byte(goFormat(id, out, 1, 2)[:3] + "0102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F20" + good[3+hexSize:]))
	f.Fuzz(func(t *testing.T, data []byte) {
		e, ok := parseEntry(read(data), &id)
		gout, gsize, gtm, err := goParse(bytes.NewReader(data), id)
		if ok != (err == nil) {
			t.Fatalf("%q: client ok=%v, go err=%v", data, ok, err)
		}
		if ok && (e.out != gout || e.size != gsize || e.time != gtm) {
			t.Fatalf("%q: client %x %d %d, go %x %d %d", data, e.out, e.size, e.time, gout, gsize, gtm)
		}
	})
}
