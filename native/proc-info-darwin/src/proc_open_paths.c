// findOpenPathsUnder(folders): every file a process holds open below one of the folders, as
// {pid, path}. One pass in C over proc_listallpids, PROC_PIDLISTFDS and PROC_PIDFDVNODEPATHINFO,
// so a caller pays one N-API crossing however many processes and descriptors there are.
#define NAPI_VERSION 8
#include <node_api.h>
#include "proc_open_paths.h"

#include <libproc.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>

#define MAX_FOLDERS 64

typedef struct {
  char *path;
  size_t length;
} folder_prefix;

static int is_under(const char *path, const folder_prefix *folders, uint32_t count) {
  for (uint32_t i = 0; i < count; i++) {
    size_t n = folders[i].length;
    if (strncmp(path, folders[i].path, n) == 0 && (path[n] == '\0' || path[n] == '/')) {
      return 1;
    }
  }
  return 0;
}

static void free_folders(folder_prefix *folders, uint32_t count) {
  for (uint32_t i = 0; i < count; i++) {
    free(folders[i].path);
  }
}

static int read_folders(napi_env env, napi_value list, folder_prefix *folders, uint32_t *count) {
  uint32_t length = 0;
  if (napi_get_array_length(env, list, &length) != napi_ok || length > MAX_FOLDERS) {
    napi_throw_type_error(env, NULL, "findOpenPathsUnder expects up to 64 folder paths");
    return 0;
  }
  *count = 0;
  for (uint32_t i = 0; i < length; i++) {
    napi_value item;
    size_t bytes = 0;
    if (napi_get_element(env, list, i, &item) != napi_ok ||
        napi_get_value_string_utf8(env, item, NULL, 0, &bytes) != napi_ok || bytes == 0) {
      napi_throw_type_error(env, NULL, "findOpenPathsUnder expects non-empty strings");
      free_folders(folders, *count);
      return 0;
    }
    char *path = malloc(bytes + 1);
    if (path == NULL) {
      free_folders(folders, *count);
      napi_throw_error(env, NULL, "out of memory");
      return 0;
    }
    napi_get_value_string_utf8(env, item, path, bytes + 1, &bytes);
    // A trailing slash would make the boundary check miss the folder itself.
    while (bytes > 1 && path[bytes - 1] == '/') {
      path[--bytes] = '\0';
    }
    folders[(*count)++] = (folder_prefix){path, bytes};
  }
  return 1;
}

static int push_hit(napi_env env, napi_value result, uint32_t index, pid_t pid, const char *path) {
  napi_value row, pid_value, path_value;
  return napi_create_object(env, &row) == napi_ok &&
         napi_create_int32(env, pid, &pid_value) == napi_ok &&
         napi_create_string_utf8(env, path, NAPI_AUTO_LENGTH, &path_value) == napi_ok &&
         napi_set_named_property(env, row, "pid", pid_value) == napi_ok &&
         napi_set_named_property(env, row, "path", path_value) == napi_ok &&
         napi_set_element(env, result, index, row) == napi_ok;
}

napi_value FindOpenPathsUnder(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "findOpenPathsUnder expects an array of folders");
    return NULL;
  }
  folder_prefix folders[MAX_FOLDERS];
  uint32_t folder_count = 0;
  if (!read_folders(env, argv[0], folders, &folder_count)) {
    return NULL;
  }
  napi_value result;
  if (napi_create_array(env, &result) != napi_ok) {
    free_folders(folders, folder_count);
    return NULL;
  }
  // Room for processes started between the size probe and the read.
  int capacity = proc_listallpids(NULL, 0) + 64;
  pid_t *pids = capacity > 64 ? calloc((size_t)capacity, sizeof(pid_t)) : NULL;
  int pid_count = pids ? proc_listallpids(pids, capacity * (int)sizeof(pid_t)) : 0;
  struct proc_fdinfo *fds = NULL;
  size_t fds_bytes = 0;
  uint32_t hits = 0;
  for (int i = 0; i < pid_count; i++) {
    pid_t pid = pids[i];
    // Another user's processes answer 0: skipped, so the result is a lower bound, as lsof's is.
    int needed = pid > 0 ? proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0) : 0;
    if (needed <= 0) {
      continue;
    }
    if ((size_t)needed > fds_bytes) {
      struct proc_fdinfo *grown = realloc(fds, (size_t)needed);
      if (grown == NULL) {
        continue;
      }
      fds = grown;
      fds_bytes = (size_t)needed;
    }
    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, (int)fds_bytes);
    int fd_count = bytes > 0 ? bytes / (int)PROC_PIDLISTFD_SIZE : 0;
    for (int j = 0; j < fd_count; j++) {
      if (fds[j].proc_fdtype != PROX_FDTYPE_VNODE) {
        continue;
      }
      struct vnode_fdinfowithpath vnode;
      int got = proc_pidfdinfo(pid, fds[j].proc_fd, PROC_PIDFDVNODEPATHINFO, &vnode,
                               PROC_PIDFDVNODEPATHINFO_SIZE);
      if (got == PROC_PIDFDVNODEPATHINFO_SIZE && vnode.pvip.vip_path[0] != '\0' &&
          is_under(vnode.pvip.vip_path, folders, folder_count)) {
        if (!push_hit(env, result, hits++, pid, vnode.pvip.vip_path)) {
          break;
        }
      }
    }
  }
  free(fds);
  free(pids);
  free_folders(folders, folder_count);
  return result;
}
