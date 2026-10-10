// Wire protocol between the `zsh` client (CLAUDE_CODE_SHELL) and pod-shelld.
// Unix stream socket, same uid only. All integers little-endian host order.
#pragma once
#include <stdint.h>

#define PNB_MAGIC 0x31424e50u /* "PNB1" */

// Client -> daemon: one request, then zero or more signal relays.
//   u32 magic, u32 total_len (bytes after this header), then fields:
//   u32 flavor (0 = eval gets `< /dev/null`, 1 = raw), u32 umask, i32 qos, i32 nice,
//   u32 sigmask, u32 sigign, u64 cwd_dev, u64 cwd_ino, u64 out_dev, u64 out_ino, i32 out_flags,
//   then length-prefixed (u32) blobs: s_pre, cmd, cwdfile, out_path, cwd, env (NUL-separated).
// Relay: u8 'S', u8 signo.
// Daemon -> client: u8 'M' (miss: run the stock shell) or u8 'X' + i32 wait status.

enum { PNB_FLAVOR_DEVNULL = 0, PNB_FLAVOR_RAW = 1 };

struct pnb_fixed {
  uint32_t flavor, umask;
  int32_t qos, nice;
  uint32_t sigmask, sigign;
  uint64_t cwd_dev, cwd_ino, out_dev, out_ino;
  int32_t out_flags;
} __attribute__((packed));

#define PNB_NBLOBS 6
enum { B_SPRE, B_CMD, B_CWDFILE, B_OUTPATH, B_CWD, B_ENV };

// Socket path: $TMPDIR/pod-shelld-<uid>/<key>.sock (dir 0700). key = POD_SHELLD_ID or CLAUDE_PID.
