// pod-search-tool: what Claude Code's Bash `grep` and `find` run in a Pod agent with POD_CLAUDE_OG=1
// (../claude-og.swift). The agent shell's .zshenv/bashenv point CLAUDE_CODE_EXECPATH here and keep
// Claude's own binary in POD_CLAUDE_EXECPATH.
//
// A ugrep call with exactly the defaults below goes to pod-search's ugrep entry (og), which execs
// OG_UGREP_FALLBACK with the same argv whenever it cannot promise ugrep's output. Everything else,
// and every ugrep call while that entry is missing, execs Claude's binary with the argv unchanged,
// argv[0] included: that binary picks ugrep, bfs or rg by argv[0]. It has no entitlements, so dyld
// prunes DYLD_* from its environment and the exec'd binary doesn't get them.
//
// Plain C: every `grep` and `find` in an agent's commands pays this binary's start.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// The snapshot `grep` defaults of the Claude builds claude-og.swift allows, in order. Any other
// vector is a build this tool was not checked against, so it goes to Claude's ugrep.
static const char *const kUgrepDefaults[] = {
  "-G", "--ignore-files", "--hidden", "-I", "--exclude-dir=.git", "--exclude-dir=.svn",
  "--exclude-dir=.hg", "--exclude-dir=.bzr", "--exclude-dir=.jj", "--exclude-dir=.sl",
};
#define UGREP_DEFAULTS (sizeof kUgrepDefaults / sizeof *kUgrepDefaults)

static int has_ugrep_defaults(int argc, char **argv) {
  if (argc < 1 + (int)UGREP_DEFAULTS || strcmp(argv[0], "ugrep") != 0) return 0;
  for (size_t i = 0; i < UGREP_DEFAULTS; i++) {
    if (strcmp(argv[1 + i], kUgrepDefaults[i]) != 0) return 0;
  }
  return 1;
}

// pod-search installs this link only once og has its ugrep mode. POD_SEARCH_UGREP overrides it
// (empty: none).
static char *ugrep_entry(void) {
  const char *override = getenv("POD_SEARCH_UGREP");
  if (override != NULL) return *override != '\0' ? strdup(override) : NULL;
  const char *home = getenv("HOME");
  if (home == NULL || *home != '/') return NULL;
  const char *suffix = "/.local/share/pod-search/ugrep-shim/ugrep";
  size_t size = strlen(home) + strlen(suffix) + 1;
  char *path = malloc(size);
  if (path != NULL) snprintf(path, size, "%s%s", home, suffix);
  return path;
}

int main(int argc, char **argv) {
  const char *real = getenv("POD_CLAUDE_EXECPATH");
  if (real == NULL || *real != '/') {
    fprintf(stderr, "pod-search-tool: POD_CLAUDE_EXECPATH is not set\n");
    return 127;
  }
  if (has_ugrep_defaults(argc, argv)) {
    char *entry = ugrep_entry();
    if (entry != NULL && access(entry, X_OK) == 0 && setenv("OG_UGREP_FALLBACK", real, 1) == 0) {
      execv(entry, argv);
    }
    // Why: no entry, or it failed to start; Claude's ugrep answers instead.
    unsetenv("OG_UGREP_FALLBACK");
  }
  execv(real, argv);
  fprintf(stderr, "pod-search-tool: %s: ", real);
  perror(NULL);
  return 126;
}
