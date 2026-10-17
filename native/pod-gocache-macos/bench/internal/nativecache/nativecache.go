// Package nativecache reads and writes Go's native GOCACHE layout, mirroring
// cmd/go/internal/cache/cache.go (Go 1.27.2): fileName, get and putIndexEntry.
package nativecache

import (
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

const (
	HashSize  = 32
	hexSize   = HashSize * 2
	entrySize = 2 + 1 + hexSize + 1 + hexSize + 1 + 20 + 1 + 20 + 1
)

// FileName is cache.go fileName: <dir>/<first byte hex>/<id hex>-<key>.
func FileName(dir string, id []byte, key string) string {
	return filepath.Join(dir, fmt.Sprintf("%02x", id[0]), fmt.Sprintf("%x", id)+"-"+key)
}

type Entry struct {
	OutputID []byte
	Size     int64
	Time     time.Time
}

var errBad = errors.New("bad action entry")

// ReadEntry parses an -a file with the same checks as cache.go get.
func ReadEntry(dir string, id []byte) (Entry, error) {
	f, err := os.Open(FileName(dir, id, "a"))
	if err != nil {
		return Entry{}, err
	}
	defer f.Close()
	var buf [entrySize + 1]byte
	n, _ := f.Read(buf[:])
	if n != entrySize {
		return Entry{}, errBad
	}
	e := buf[:entrySize]
	if e[0] != 'v' || e[1] != '1' || e[2] != ' ' || e[3+hexSize] != ' ' || e[3+hexSize+1+hexSize] != ' ' ||
		e[3+hexSize+1+hexSize+1+20] != ' ' || e[entrySize-1] != '\n' {
		return Entry{}, errBad
	}
	var aid [HashSize]byte
	if _, err := hex.Decode(aid[:], e[3:3+hexSize]); err != nil || string(aid[:]) != string(id) {
		return Entry{}, errBad
	}
	out := make([]byte, HashSize)
	if _, err := hex.Decode(out, e[3+hexSize+1:3+hexSize+1+hexSize]); err != nil {
		return Entry{}, errBad
	}
	rest := e[3+hexSize+1+hexSize+1:]
	size, err1 := strconv.ParseInt(trimSpace(rest[:20]), 10, 64)
	tm, err2 := strconv.ParseInt(trimSpace(rest[21:41]), 10, 64)
	if err1 != nil || err2 != nil || size < 0 || tm < 0 {
		return Entry{}, errBad
	}
	return Entry{OutputID: out, Size: size, Time: time.Unix(0, tm)}, nil
}

func trimSpace(b []byte) string {
	i := 0
	for i < len(b) && b[i] == ' ' {
		i++
	}
	return string(b[i:])
}

// WriteEntry is cache.go putIndexEntry: write first, truncate after, so a rewrite of the same
// content never shows a shorter file to a concurrent reader.
func WriteEntry(dir string, id, out []byte, size int64) error {
	entry := fmt.Sprintf("v1 %x %x %20d %20d\n", id, out, size, time.Now().UnixNano())
	name := FileName(dir, id, "a")
	f, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE, 0o666)
	if err != nil {
		return err
	}
	_, err = f.WriteString(entry)
	if err == nil {
		err = f.Truncate(int64(len(entry)))
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(name)
	}
	return err
}
