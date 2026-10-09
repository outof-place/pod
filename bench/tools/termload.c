// termload: runs one output workload inside the terminal under test, then waits until that
// terminal has consumed all of it, and writes the timings as JSON to --out.
//
//   termload --out FILE -- CMD [ARGS...]     run CMD with stdout on this terminal
//   termload --out FILE --tui FRAMES         full-screen 80x24 repaint flood (alternate screen)
//
// "Consumed" is a primary device-attributes round trip (CSI c) after the output, as vtebench does:
// a terminal answers it only after parsing every byte written before it.
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

static uint64_t mono_ns(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW); }
static double wall_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  return (double)ts.tv_sec * 1e3 + (double)ts.tv_nsec / 1e6;
}

static int write_all(int fd, const char *buf, size_t len) {
  while (len > 0) {
    ssize_t w = write(fd, buf, len);
    if (w < 0 && errno == EINTR) continue;
    if (w < 0) return -1;
    buf += w;
    len -= (size_t)w;
  }
  return 0;
}

// Writes CSI c and reads until the reply's final 'c'. Returns 0 and the reply (escaped) on success.
static int da1_sync(char *reply, size_t cap, int timeout_ms) {
  int fd = open("/dev/tty", O_RDWR | O_NOCTTY);
  if (fd < 0) return -1;
  struct termios saved, raw;
  tcgetattr(fd, &saved);
  raw = saved;
  raw.c_lflag &= ~(tcflag_t)(ICANON | ECHO);
  raw.c_cc[VMIN] = 0;
  raw.c_cc[VTIME] = 0;
  tcsetattr(fd, TCSANOW, &raw);
  tcflush(fd, TCIFLUSH);
  int rc = write_all(fd, "\033[c", 3);
  size_t used = 0;
  int seen_csi = 0, done = 0;
  uint64_t deadline = mono_ns() + (uint64_t)timeout_ms * 1000000ull;
  while (rc == 0 && !done) {
    int left = (int)((deadline - mono_ns()) / 1000000ull);
    if ((int64_t)(deadline - mono_ns()) <= 0) {
      rc = -1;
      break;
    }
    struct pollfd p = {fd, POLLIN, 0};
    if (poll(&p, 1, left) <= 0) continue;
    char c;
    if (read(fd, &c, 1) != 1) continue;
    if (c == '[' && used > 0) seen_csi = 1;
    if (used + 5 < cap) {
      if (c == '\033') {
        memcpy(reply + used, "\\\\e", 3);
        used += 3;
      } else if ((unsigned char)c >= 0x20 && c != '"' && c != '\\') {
        reply[used++] = c;
      }
    }
    if (seen_csi && c == 'c') done = 1;
  }
  reply[used] = 0;
  tcsetattr(fd, TCSANOW, &saved);
  close(fd);
  return rc;
}

static long tui_flood(int frames) {
  const int cols = 80, rows = 24;
  static char frame[64 * 1024];
  long bytes = 0;
  const char *enter = "\033[?1049h\033[?25l";
  write_all(1, enter, strlen(enter));
  bytes += (long)strlen(enter);
  for (int f = 0; f < frames; f++) {
    size_t used = 0;
    for (int r = 0; r < rows; r++) {
      used += (size_t)snprintf(frame + used, sizeof(frame) - used, "\033[%d;1H\033[38;5;%dm\033[48;5;%dm",
                               r + 1, 16 + (f + r) % 216, 232 + (f + r) % 24);
      for (int c = 0; c < cols; c++) frame[used++] = (char)('!' + (f + r * 7 + c) % 94);
    }
    used += (size_t)snprintf(frame + used, sizeof(frame) - used, "\033[0m");
    write_all(1, frame, used);
    bytes += (long)used;
  }
  const char *leave = "\033[?25h\033[?1049l";
  write_all(1, leave, strlen(leave));
  return bytes + (long)strlen(leave);
}

int main(int argc, char **argv) {
  const char *out = NULL;
  int tui_frames = 0, cmd_at = -1;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--out") && i + 1 < argc) out = argv[++i];
    else if (!strcmp(argv[i], "--tui") && i + 1 < argc) tui_frames = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--")) {
      cmd_at = i + 1;
      break;
    }
  }
  if (!out || (tui_frames <= 0 && (cmd_at < 0 || cmd_at >= argc))) {
    fprintf(stderr, "usage: termload --out FILE (--tui FRAMES | -- CMD [ARGS...])\n");
    return 2;
  }
  struct winsize ws = {0};
  ioctl(1, TIOCGWINSZ, &ws);
  double started_wall = wall_ms();
  uint64_t t0 = mono_ns();
  long bytes = -1;
  int exit_code = 0;
  struct rusage child = {0};
  if (tui_frames > 0) {
    bytes = tui_flood(tui_frames);
  } else {
    pid_t pid;
    if (posix_spawnp(&pid, argv[cmd_at], NULL, NULL, &argv[cmd_at], environ) != 0) return 1;
    int status;
    while (wait4(pid, &status, 0, &child) < 0 && errno == EINTR) {
    }
    exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
  }
  uint64_t t1 = mono_ns();
  char reply[128];
  int sync = da1_sync(reply, sizeof(reply), 300000);
  uint64_t t2 = mono_ns();

  char tmp[4096];
  snprintf(tmp, sizeof(tmp), "%s.tmp", out);
  FILE *f = fopen(tmp, "w");
  if (!f) return 1;
  fprintf(f,
          "{\"startedAtMs\":%.3f,\"producerMs\":%.3f,\"syncMs\":%.3f,\"totalMs\":%.3f,"
          "\"synced\":%s,\"daReply\":\"%s\",\"bytes\":%ld,\"exit\":%d,"
          "\"cols\":%d,\"rows\":%d,\"childUserMs\":%.3f,\"childSysMs\":%.3f}\n",
          started_wall, (double)(t1 - t0) / 1e6, (double)(t2 - t1) / 1e6, (double)(t2 - t0) / 1e6,
          sync == 0 ? "true" : "false", reply, bytes, exit_code, ws.ws_col, ws.ws_row,
          (double)child.ru_utime.tv_sec * 1e3 + (double)child.ru_utime.tv_usec / 1e3,
          (double)child.ru_stime.tv_sec * 1e3 + (double)child.ru_stime.tv_usec / 1e3);
  fclose(f);
  rename(tmp, out);
  return sync == 0 ? 0 : 1;
}
