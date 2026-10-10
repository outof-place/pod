// Fork-only (Pod): the in-VM half of the sandbox relay, run as root by `orb run … python3 -I -c`.
// Frames on stdin/stdout: kind u8, connection u32, length u32 (big-endian), then the payload.

export const RELAY_FRAME = { open: 1, data: 2, end: 3, close: 4, ready: 5 } as const
export const RELAY_HEADER_BYTES = 9
/** Where the relay records its pid and the nonce a launch waits for; tmpfs, so a reboot clears it. */
export const RELAY_STATE_DIR = '/run/pod-sandbox-relay'

/** Where a sandbox trusts its relay CA; NODE_EXTRA_CA_CERTS points Claude Code here. */
export const SANDBOX_CA_PATH = '/etc/pod-sandbox/anthropic-ca.pem'

/**
 * argv[1] is JSON: { nonce, stateDir, routes: [port, …], ipv6Routes: [index, …], hosts: { file,
 * names }, files: { path: content | null } }. OPEN carries the route's index; ipv6Routes also
 * listen on ::1. The hosts block and files exist only while this relay runs.
 */
export const SANDBOX_RELAY_AGENT_PY = String.raw`
import json, os, signal, socket, struct, sys, threading, time
OPEN, DATA, END, CLOSE, READY = 1, 2, 3, 4, 5
HEADER = struct.Struct('>BII')
spec = json.loads(sys.argv[1])
state = spec['stateDir']
out = sys.stdout.buffer
inp = sys.stdin.buffer
out_lock = threading.Lock()
conns_lock = threading.Lock()
conns = {}
ended = {}
counter = [0]

def send(kind, conn, payload=b''):
    with out_lock:
        out.write(HEADER.pack(kind, conn, len(payload)) + payload)
        out.flush()

def drop(conn):
    with conns_lock:
        sock = conns.pop(conn, None)
        ended.pop(conn, None)
    if sock is not None:
        try:
            sock.close()
        except OSError:
            pass

def finish(conn, side):
    with conns_lock:
        sides = ended.get(conn)
        if sides is None:
            return
        sides.add(side)
        done = len(sides) == 2
    if done:
        drop(conn)

def pump(conn, sock):
    try:
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            send(DATA, conn, chunk)
        send(END, conn)
        finish(conn, 'local')
    except OSError:
        if conn in conns:
            drop(conn)
            send(CLOSE, conn)

def serve(listener, index):
    while True:
        sock, _ = listener.accept()
        with conns_lock:
            counter[0] += 1
            conn = counter[0]
            conns[conn] = sock
            ended[conn] = set()
        send(OPEN, conn, bytes([index]))
        threading.Thread(target=pump, args=(conn, sock), daemon=True).start()

def stop_previous():
    try:
        pid = int(open(os.path.join(state, 'pid')).read())
    except (OSError, ValueError):
        return
    if pid == os.getpid():
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass

def bind(port, family=socket.AF_INET):
    deadline = time.monotonic() + 5
    while True:
        listener = socket.socket(family, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind(('::1' if family == socket.AF_INET6 else '127.0.0.1', port))
            listener.listen(64)
            return listener
        except OSError:
            listener.close()
            if time.monotonic() > deadline:
                raise
            time.sleep(0.1)

BEGIN = '# pod-sandbox-relay begin'
FINISH = '# pod-sandbox-relay end'

def pin_hosts(names):
    path = spec['hosts']['file']
    try:
        text = open(path).read()
    except OSError:
        text = ''
    kept, skip = [], False
    for line in text.splitlines(True):
        mark = line.strip()
        if mark == BEGIN:
            skip = True
        elif mark == FINISH:
            skip = False
        elif not skip:
            kept.append(line)
    text = ''.join(kept)
    if names:
        if text and not text.endswith('\n'):
            text += '\n'
        # Both families: a resolver asking for IPv6 alone would otherwise go to DNS.
        pins = ''.join('127.0.0.1 %s\n::1 %s\n' % (n, n) for n in names)
        text += BEGIN + '\n' + pins + FINISH + '\n'
    # In place: /etc/hosts may be a bind mount that a rename cannot replace.
    with open(path, 'w') as f:
        f.write(text)

def place_files(files):
    for path, content in files.items():
        if content is None:
            try:
                os.remove(path)
            except OSError:
                pass
        else:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w') as f:
                f.write(content)
            os.chmod(path, 0o644)

def read_exact(size):
    data = inp.read(size) if size else b''
    return data if len(data) == size else None

os.makedirs(state, exist_ok=True)
stop_previous()
listeners = [(index, bind(port)) for index, port in enumerate(spec['routes'])]
listeners += [(index, bind(spec['routes'][index], socket.AF_INET6)) for index in spec.get('ipv6Routes', [])]
with open(os.path.join(state, 'pid'), 'w') as f:
    f.write(str(os.getpid()))
for index, listener in listeners:
    threading.Thread(target=serve, args=(listener, index), daemon=True).start()
place_files(spec['files'])
pin_hosts(spec['hosts']['names'])
with open(os.path.join(state, 'ready'), 'w') as f:
    f.write(spec['nonce'])
send(READY, 0)

while True:
    header = read_exact(9)
    if header is None:
        break
    kind, conn, length = HEADER.unpack(header)
    payload = read_exact(length)
    if payload is None:
        break
    with conns_lock:
        sock = conns.get(conn)
    if sock is None:
        continue
    try:
        if kind == DATA:
            sock.sendall(payload)
        elif kind == END:
            sock.shutdown(socket.SHUT_WR)
            finish(conn, 'remote')
        elif kind == CLOSE:
            drop(conn)
    except OSError:
        drop(conn)
        send(CLOSE, conn)

try:
    current = open(os.path.join(state, 'pid')).read() == str(os.getpid())
except OSError:
    current = False
if current:
    pin_hosts([])
    place_files({path: None for path in spec['files']})
    for name in ('ready', 'pid'):
        try:
            os.remove(os.path.join(state, name))
        except OSError:
            pass
os._exit(0)
`
