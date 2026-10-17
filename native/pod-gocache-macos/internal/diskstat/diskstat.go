// Package diskstat reports free disk space with one statfs(2) call.
package diskstat

import (
	"path/filepath"
	"syscall"
)

// Source reports bytes available to an unprivileged writer.
type Source interface {
	Free() (int64, error)
}

// Statfs measures the volume holding Path, walking up to the nearest existing
// parent (the cache directory may not exist yet).
type Statfs struct{ Path string }

func (s Statfs) Free() (int64, error) {
	p := s.Path
	for {
		var st syscall.Statfs_t
		err := syscall.Statfs(p, &st)
		if err == nil {
			return int64(st.Bavail) * int64(st.Bsize), nil
		}
		parent := filepath.Dir(p)
		if err != syscall.ENOENT || parent == p {
			return 0, err
		}
		p = parent
	}
}
