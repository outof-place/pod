// Fork-only (Pod): the in-VM half of the sandbox relay, run as root by `orb run … python3 -I -c`.
// Frames on stdin/stdout: kind u8, connection u32, length u32 (big-endian), then the payload.

export const RELAY_FRAME = { open: 1, data: 2, end: 3, close: 4, ready: 5 } as const
export const RELAY_HEADER_BYTES = 9
/** Where the relay records its pid and the nonce a launch waits for; tmpfs, so a reboot clears it. */
export const RELAY_STATE_DIR = '/run/pod-sandbox-relay'

/** argv[1] is JSON: { nonce, stateDir, routes: [port, …] }; OPEN carries the route's index. */
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

def bind(port):
    deadline = time.monotonic() + 5
    while True:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind(('127.0.0.1', port))
            listener.listen(64)
            return listener
        except OSError:
            listener.close()
            if time.monotonic() > deadline:
                raise
            time.sleep(0.1)

def read_exact(size):
    data = inp.read(size) if size else b''
    return data if len(data) == size else None

os.makedirs(state, exist_ok=True)
stop_previous()
listeners = [bind(port) for port in spec['routes']]
with open(os.path.join(state, 'pid'), 'w') as f:
    f.write(str(os.getpid()))
for index, listener in enumerate(listeners):
    threading.Thread(target=serve, args=(listener, index), daemon=True).start()
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

for name in ('ready', 'pid'):
    try:
        if open(os.path.join(state, 'pid')).read() == str(os.getpid()):
            os.remove(os.path.join(state, name))
    except OSError:
        pass
os._exit(0)
`
