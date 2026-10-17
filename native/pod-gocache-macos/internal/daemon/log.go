package daemon

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/ownerstate"
)

// Logger writes one line per event. When stderr is the state directory's
// daemon.log (launchd's StandardErrorPath), it rotates that file itself:
// launchd holds the descriptor and Pod rotates only at its own launch.
type Logger struct {
	mu     sync.Mutex
	w      io.Writer
	clock  func() time.Time
	rotate *rotation
	once   map[string]bool
}

type rotation struct {
	path string
	max  int64
}

func NewLogger(w io.Writer, clock func() time.Time) *Logger {
	return &Logger{w: w, clock: clock, once: map[string]bool{}}
}

// rotateStderr turns on rotation when fd 2 is stateDir/daemon.log.
func (l *Logger) rotateStderr(stateDir string, max int64) {
	path := filepath.Join(stateDir, ownerstate.LogFile)
	var fdSt, pathSt syscall.Stat_t
	if syscall.Fstat(2, &fdSt) != nil || syscall.Stat(path, &pathSt) != nil {
		return
	}
	if fdSt.Dev == pathSt.Dev && fdSt.Ino == pathSt.Ino && fdSt.Mode&syscall.S_IFMT == syscall.S_IFREG {
		l.rotate = &rotation{path: path, max: max}
	}
}

func (l *Logger) Printf(format string, a ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	fmt.Fprintf(l.w, "%s %s\n", l.clock().Format(time.RFC3339), fmt.Sprintf(format, a...))
	if l.rotate != nil {
		l.maybeRotate()
	}
}

// Once logs a message the first time its key is seen.
func (l *Logger) Once(key, format string, a ...any) {
	l.mu.Lock()
	seen := l.once[key]
	l.once[key] = true
	l.mu.Unlock()
	if !seen {
		l.Printf(format, a...)
	}
}

// maybeRotate keeps one previous generation: daemon.log.1.
func (l *Logger) maybeRotate() {
	var st syscall.Stat_t
	if syscall.Fstat(2, &st) != nil || st.Size < l.rotate.max {
		return
	}
	if err := os.Rename(l.rotate.path, l.rotate.path+".1"); err != nil {
		return
	}
	fd, err := syscall.Open(l.rotate.path, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_APPEND|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return
	}
	syscall.Dup2(fd, 2)
	syscall.Close(fd)
}
