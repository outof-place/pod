package realgo

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/outof-place/pod/native/pod-gocache-macos/internal/realhome"
)

// clientBin is the pod-gocache binary built once for the package's tests.
// POD_GOCACHE_CLIENT_BIN runs them with another build instead (the S14 skew
// matrix: an S1 client against this daemon).
var clientBin string

func TestMain(m *testing.M) {
	home := os.Getenv("HOME") // G3: the real one, checked after the tests
	if os.Getenv("POD_GOCACHE_REALGO") != "1" {
		os.Exit(realhome.Run(m, home))
	}
	if bin := os.Getenv("POD_GOCACHE_CLIENT_BIN"); bin != "" {
		clientBin = bin
		os.Exit(realhome.Run(m, home))
	}
	dir, err := os.MkdirTemp("", "pgc-realgo-bin-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	clientBin = filepath.Join(dir, "pod-gocache")
	build := exec.Command("go", "build", "-o", clientBin, "../../cmd/pod-gocache")
	build.Stdout, build.Stderr = os.Stdout, os.Stderr
	if err := build.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "building pod-gocache:", err)
		os.Exit(1)
	}
	code := realhome.Run(m, home)
	os.RemoveAll(dir)
	os.Exit(code)
}

func requireRealGo(t *testing.T) {
	t.Helper()
	if os.Getenv("POD_GOCACHE_REALGO") != "1" {
		t.Skip("set POD_GOCACHE_REALGO=1 to run real go commands")
	}
}

// workspace is one copy of the fixture module plus an output dir.
type workspace struct {
	src string
	out string
}

func newWorkspace(t *testing.T) workspace {
	t.Helper()
	root := canonical(t, t.TempDir())
	ws := workspace{src: filepath.Join(root, "src"), out: filepath.Join(root, "out")}
	copyTree(t, "testdata/fixture", ws.src)
	writeBigPackage(t, filepath.Join(ws.src, "big"))
	if err := os.MkdirAll(ws.out, 0o755); err != nil {
		t.Fatal(err)
	}
	backdate(t, ws.src)
	return ws
}

// backdate gives every source file an old mtime: go skips indexing and test
// input hashing of files modified in the last seconds, which would make runs
// depend on timing.
func backdate(t *testing.T, dir string) {
	t.Helper()
	old := time.Now().Add(-time.Hour)
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Chtimes(path, old, old)
	})
	if err != nil {
		t.Fatal(err)
	}
}

// writeBigPackage generates a package whose archive is a few MB, so puts span
// many reads of the client's input buffer.
func writeBigPackage(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	r := rand.New(rand.NewPCG(1, 2))
	raw := make([]byte, 1<<20)
	for i := range raw {
		raw[i] = byte(r.Uint32())
	}
	var b strings.Builder
	b.WriteString("// Package big holds a large table.\npackage big\n\n// Blob is pseudo-random data.\nvar Blob = \"")
	b.WriteString(hex.EncodeToString(raw))
	b.WriteString("\"\n\n// Len is the table size.\nfunc Len() int { return len(Blob) }\n")
	if err := os.WriteFile(filepath.Join(dir, "big.go"), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
}

func copyTree(t *testing.T, from, to string) {
	t.Helper()
	err := filepath.WalkDir(from, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(from, path)
		dst := filepath.Join(to, rel)
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(dst, data, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func resetDir(t *testing.T, dir string) {
	t.Helper()
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
}

func canonical(t *testing.T, dir string) string {
	t.Helper()
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	return real
}

// cacheEnv describes how go finds its cache in one run.
type cacheEnv struct {
	gocache string
	trace   string // POD_GOCACHE_TRACE_DIR for the client
	live    string // POD_GOCACHE_LIVE_DIR: this test's own shared-state root (G3)
	prog    bool   // set GOCACHEPROG to the client
	extra   []string
}

func newCache(t *testing.T, prog bool) cacheEnv {
	t.Helper()
	root := canonical(t, t.TempDir())
	ce := cacheEnv{gocache: filepath.Join(root, "gocache"), trace: filepath.Join(root, "trace"), live: filepath.Join(root, "live"), prog: prog}
	if err := os.MkdirAll(ce.gocache, 0o755); err != nil {
		t.Fatal(err)
	}
	return ce
}

func (ce cacheEnv) withProg(prog bool) cacheEnv {
	ce.prog = prog
	return ce
}

func (ce cacheEnv) mode() string {
	if ce.prog {
		return "client"
	}
	return "builtin"
}

type result struct {
	code   int
	stdout string
	stderr string
}

var dropEnv = map[string]bool{
	"GOCACHE": true, "GOCACHEPROG": true, "GOFLAGS": true, "GOENV": true, "GOTOOLCHAIN": true,
	"CGO_ENABLED": true, "GOWORK": true, "GOPROXY": true, "GOEXPERIMENT": true, "GODEBUG": true,
	"GOOS": true, "GOARCH": true, "GOROOT": true,
}

// goEnv is a hermetic environment: the user's go env file and flags never leak in.
func goEnv(ce cacheEnv) []string {
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if dropEnv[k] || strings.HasPrefix(k, "POD_GOCACHE_") {
			continue
		}
		env = append(env, kv)
	}
	env = append(env,
		"GOCACHE="+ce.gocache,
		"GOENV=off",
		"GOTOOLCHAIN=local",
		"CGO_ENABLED=0",
		"GOWORK=off",
		"GOPROXY=off",
		"GOFLAGS=-p=2 -trimpath",
		"POD_GOCACHE_TRACE_DIR="+ce.trace,
		"POD_GOCACHE_LIVE_DIR="+ce.live,
	)
	if ce.prog {
		env = append(env, "GOCACHEPROG="+clientBin+" prog")
	}
	return append(env, ce.extra...)
}

func guardCache(t *testing.T, gocache string) {
	t.Helper()
	ucd, err := os.UserCacheDir()
	if err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(ucd, "go-build")
	if gocache == "" || strings.HasPrefix(filepath.Clean(gocache), real) {
		t.Fatalf("refusing to run against %q", gocache)
	}
}

func runGo(t *testing.T, ws workspace, ce cacheEnv, args ...string) result {
	t.Helper()
	guardCache(t, ce.gocache)
	for i, a := range args {
		args[i] = strings.ReplaceAll(a, "$OUT", ws.out)
	}
	cmd := exec.Command("go", args...)
	cmd.Dir = ws.src
	cmd.Env = goEnv(ce)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	code := 0
	if err != nil {
		ee, ok := err.(*exec.ExitError)
		if !ok {
			t.Fatalf("go %v: %v", args, err)
		}
		code = ee.ExitCode()
	}
	return result{code: code, stdout: stdout.String(), stderr: stderr.String()}
}

var durationRE = regexp.MustCompile(`\b\d+\.\d+s\b`)

func normalize(s string, ws workspace, ce cacheEnv) string {
	for _, r := range []struct{ from, to string }{
		{ce.gocache, "$GOCACHE"}, {ws.out, "$OUT"}, {ws.src, "$SRC"},
	} {
		s = strings.ReplaceAll(s, r.from, r.to)
		s = strings.ReplaceAll(s, strings.TrimPrefix(r.from, "/private"), r.to)
	}
	return durationRE.ReplaceAllString(s, "Ns")
}

func fileSum(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		return "missing: " + err.Error()
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:8])
}

func tail(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// checkStore verifies the cache directory is consistent: every output file's
// content hashes to its name, every index entry points at a complete output,
// and no temp file is left behind.
func checkStore(t *testing.T, dir string) (entries, outputs int) {
	t.Helper()
	return checkStoreTorn(t, dir, false)
}

// checkStoreTorn is checkStore that, with torn set, accepts index entries a
// killed writer left empty: go reads those as misses, as it does for its own.
func checkStoreTorn(t *testing.T, dir string, torn bool) (entries, outputs int) {
	t.Helper()
	buckets, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range buckets {
		if !b.IsDir() || len(b.Name()) != 2 {
			continue
		}
		files, _ := os.ReadDir(filepath.Join(dir, b.Name()))
		for _, f := range files {
			path := filepath.Join(dir, b.Name(), f.Name())
			name := f.Name()
			switch {
			case strings.HasPrefix(name, ".pgc-tmp."):
				t.Errorf("temp file left: %s", path)
			case strings.HasSuffix(name, "-d") && !f.IsDir():
				outputs++
				data, _ := os.ReadFile(path)
				if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != strings.TrimSuffix(name, "-d") {
					t.Errorf("output %s does not hash to its name", path)
				}
			case strings.HasSuffix(name, "-a"):
				entries++
				line, _ := os.ReadFile(path)
				fields := strings.Fields(string(line))
				if len(fields) != 5 || fields[0] != "v1" || fields[1] != strings.TrimSuffix(name, "-a") {
					if torn && len(line) == 0 {
						t.Logf("empty index entry left by a killed writer: %s", name)
						continue
					}
					t.Errorf("bad index entry %s: %q", path, line)
					continue
				}
				out := filepath.Join(dir, fields[2][:2], fields[2]+"-d")
				fi, err := os.Stat(out)
				if err != nil {
					t.Errorf("entry %s points at missing output: %v", name, err)
				} else if !fi.IsDir() && fmt.Sprint(fi.Size()) != fields[3] {
					t.Errorf("entry %s: output size %d, entry says %s", name, fi.Size(), fields[3])
				}
			}
		}
	}
	return entries, outputs
}
