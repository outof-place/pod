// Fork-only (Pod): findOpenPathsUnder(folders) → Promise<{pid, path}[]>: every file a process holds
// open below one of the folders. One pass over proc_listallpids, PROC_PIDLISTFDS and
// PROC_PIDFDVNODEPATHINFO on a libuv worker thread (napi_async_work), so tens of thousands of
// syscalls never stall the runtime's event loop; only the result crosses back to JavaScript.
#define NAPI_VERSION 8
#include <node_api.h>
#include "proc_open_paths.h"

#include <errno.h>
#include <libproc.h>
#include <stdlib.h>
#include <string.h>
#include <sys/param.h>
#include <sys/proc_info.h>

#define MAX_FOLDERS 64
#define PID_SLACK 256

typedef struct {
  char path[MAXPATHLEN];
  size_t length;
} folder_prefix;

typedef struct {
  pid_t pid;
  char path[MAXPATHLEN];
} open_hit;

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  folder_prefix folders[MAX_FOLDERS];
  uint32_t folder_count;
  open_hit *hits;
  size_t hit_count;
  size_t hit_capacity;
  // Set on the worker thread; the promise rejects with it on the main thread.
  const char *error;
} scan_job;

static int is_under(const char *path, const folder_prefix *folders, uint32_t count) {
  for (uint32_t i = 0; i < count; i++) {
    size_t n = folders[i].length;
    if (strncmp(path, folders[i].path, n) == 0 && (path[n] == '\0' || path[n] == '/')) {
      return 1;
    }
  }
  return 0;
}

static int add_hit(scan_job *job, pid_t pid, const char *path) {
  if (job->hit_count == job->hit_capacity) {
    size_t capacity = job->hit_capacity ? job->hit_capacity * 2 : 64;
    open_hit *grown = realloc(job->hits, capacity * sizeof(open_hit));
    if (grown == NULL) {
      return 0;
    }
    job->hits = grown;
    job->hit_capacity = capacity;
  }
  open_hit *hit = &job->hits[job->hit_count++];
  hit->pid = pid;
  strlcpy(hit->path, path, sizeof(hit->path));
  return 1;
}

/** Every pid, retried with a bigger buffer while the table fills it (processes keep starting). */
static pid_t *list_pids(int *count) {
  for (int attempt = 0; attempt < 4; attempt++) {
    int probe = proc_listallpids(NULL, 0);
    if (probe <= 0) {
      return NULL;
    }
    int capacity = probe + PID_SLACK * (attempt + 1);
    pid_t *pids = calloc((size_t)capacity, sizeof(pid_t));
    if (pids == NULL) {
      return NULL;
    }
    int listed = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
    if (listed > 0 && listed < capacity) {
      *count = listed;
      return pids;
    }
    free(pids);
  }
  return NULL;
}

static void scan(napi_env env, void *data) {
  (void)env;
  scan_job *job = data;
  int pid_count = 0;
  pid_t *pids = list_pids(&pid_count);
  if (pids == NULL) {
    job->error = "proc_listallpids failed";
    return;
  }
  struct proc_fdinfo *fds = NULL;
  size_t fds_bytes = 0;
  for (int i = 0; i < pid_count && job->error == NULL; i++) {
    pid_t pid = pids[i];
    // Another user's processes answer 0: skipped, so the result is a lower bound, as lsof's is.
    int needed = pid > 0 ? proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0) : 0;
    if (needed <= 0) {
      continue;
    }
    if ((size_t)needed > fds_bytes) {
      struct proc_fdinfo *grown = realloc(fds, (size_t)needed);
      if (grown == NULL) {
        job->error = "out of memory";
        break;
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
      if (got != PROC_PIDFDVNODEPATHINFO_SIZE) {
        continue;
      }
      vnode.pvip.vip_path[MAXPATHLEN - 1] = '\0';
      if (vnode.pvip.vip_path[0] != '\0' &&
          is_under(vnode.pvip.vip_path, job->folders, job->folder_count) &&
          !add_hit(job, pid, vnode.pvip.vip_path)) {
        job->error = "out of memory";
        break;
      }
    }
  }
  free(fds);
  free(pids);
}

static void reject(napi_env env, napi_deferred deferred, const char *text) {
  napi_value message, error;
  napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &message);
  napi_create_error(env, NULL, message, &error);
  napi_reject_deferred(env, deferred, error);
}

static void settle(napi_env env, napi_status status, void *data) {
  scan_job *job = data;
  napi_value result = NULL;
  int ok = status == napi_ok && job->error == NULL && napi_create_array(env, &result) == napi_ok;
  for (size_t i = 0; ok && i < job->hit_count; i++) {
    napi_value row, pid_value, path_value;
    ok = napi_create_object(env, &row) == napi_ok &&
         napi_create_int32(env, job->hits[i].pid, &pid_value) == napi_ok &&
         napi_create_string_utf8(env, job->hits[i].path, NAPI_AUTO_LENGTH, &path_value) == napi_ok &&
         napi_set_named_property(env, row, "pid", pid_value) == napi_ok &&
         napi_set_named_property(env, row, "path", path_value) == napi_ok &&
         napi_set_element(env, result, (uint32_t)i, row) == napi_ok;
  }
  if (ok) {
    napi_resolve_deferred(env, job->deferred, result);
  } else {
    reject(env, job->deferred, job->error ? job->error : "open-file scan failed");
  }
  napi_delete_async_work(env, job->work);
  free(job->hits);
  free(job);
}

/** Copies the folder list on the main thread; the worker then touches only the job. */
static int read_folders(napi_env env, napi_value list, scan_job *job) {
  uint32_t length = 0;
  if (napi_get_array_length(env, list, &length) != napi_ok || length > MAX_FOLDERS) {
    napi_throw_type_error(env, NULL, "findOpenPathsUnder expects up to 64 folder paths");
    return 0;
  }
  for (uint32_t i = 0; i < length; i++) {
    napi_value item;
    size_t bytes = 0;
    if (napi_get_element(env, list, i, &item) != napi_ok ||
        napi_get_value_string_utf8(env, item, NULL, 0, &bytes) != napi_ok || bytes == 0 ||
        bytes >= MAXPATHLEN) {
      napi_throw_type_error(env, NULL, "findOpenPathsUnder expects paths shorter than MAXPATHLEN");
      return 0;
    }
    folder_prefix *folder = &job->folders[i];
    napi_get_value_string_utf8(env, item, folder->path, sizeof(folder->path), &bytes);
    // A trailing slash would make the boundary check miss the folder itself.
    while (bytes > 1 && folder->path[bytes - 1] == '/') {
      folder->path[--bytes] = '\0';
    }
    folder->length = bytes;
  }
  job->folder_count = length;
  return 1;
}

napi_value FindOpenPathsUnder(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "findOpenPathsUnder expects an array of folders");
    return NULL;
  }
  scan_job *job = calloc(1, sizeof(scan_job));
  if (job == NULL) {
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }
  if (!read_folders(env, argv[0], job)) {
    free(job);
    return NULL;
  }
  napi_value promise, name, empty;
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok) {
    free(job);
    napi_throw_error(env, NULL, "could not queue the open-file scan");
    return NULL;
  }
  // From here every failure rejects the promise, so the deferred never leaks.
  if (job->folder_count == 0) {
    // Nothing is open below no folder: no pass over every process.
    if (napi_create_array(env, &empty) == napi_ok) {
      napi_resolve_deferred(env, job->deferred, empty);
    } else {
      reject(env, job->deferred, "out of memory");
    }
  } else if (napi_create_string_utf8(env, "findOpenPathsUnder", NAPI_AUTO_LENGTH, &name) != napi_ok ||
             napi_create_async_work(env, NULL, name, scan, settle, job, &job->work) != napi_ok) {
    reject(env, job->deferred, "could not queue the open-file scan");
  } else if (napi_queue_async_work(env, job->work) != napi_ok) {
    napi_delete_async_work(env, job->work);
    reject(env, job->deferred, "could not queue the open-file scan");
  } else {
    // settle frees the job.
    return promise;
  }
  free(job);
  return promise;
}
