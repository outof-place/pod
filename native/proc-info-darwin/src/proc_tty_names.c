#include "proc_tty_names.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/param.h>
#include <sys/stat.h>
#include <sys/sysctl.h>

#define TTY_NAME_CACHE_SIZE 512

static _Thread_local struct {
  dev_t dev;
  char name[MAXNAMLEN];
} tty_name_cache[TTY_NAME_CACHE_SIZE];
static _Thread_local size_t tty_name_cache_length = 0;

static const char *cached_tty_name(dev_t dev) {
  for (size_t i = 0; i < tty_name_cache_length; i++) {
    if (tty_name_cache[i].dev == dev) {
      return tty_name_cache[i].name;
    }
  }
  return NULL;
}

static void cache_tty_name(dev_t dev, const char *name) {
  size_t slot = tty_name_cache_length < TTY_NAME_CACHE_SIZE
                    ? tty_name_cache_length++
                    : (size_t)dev % TTY_NAME_CACHE_SIZE;
  tty_name_cache[slot].dev = dev;
  strlcpy(tty_name_cache[slot].name, name, sizeof(tty_name_cache[slot].name));
}

void preload_process_tty_names(const struct kinfo_proc *procs, size_t count) {
  dev_t missing[TTY_NAME_CACHE_SIZE];
  size_t missing_count = 0;
  for (size_t i = 0; i < count && missing_count < TTY_NAME_CACHE_SIZE; i++) {
    dev_t dev = procs[i].kp_eproc.e_tdev;
    if (dev == NODEV || cached_tty_name(dev) != NULL) {
      continue;
    }
    size_t index = 0;
    while (index < missing_count && missing[index] != dev) {
      index++;
    }
    if (index == missing_count) {
      missing[missing_count++] = dev;
    }
  }
  if (missing_count == 0) {
    return;
  }
  DIR *devices = opendir("/dev");
  if (devices == NULL) {
    return;
  }
  struct dirent *entry;
  while (missing_count > 0 && (entry = readdir(devices)) != NULL) {
    char path[sizeof("/dev/") + MAXNAMLEN];
    snprintf(path, sizeof(path), "/dev/%s", entry->d_name);
    struct stat info;
    if (lstat(path, &info) != 0 || !S_ISCHR(info.st_mode)) {
      continue;
    }
    for (size_t i = 0; i < missing_count; i++) {
      if (info.st_rdev == missing[i]) {
        // devname_r chooses the first matching alias in this same directory order.
        if (entry->d_namlen < MAXNAMLEN) {
          cache_tty_name(missing[i], entry->d_name);
        }
        missing[i] = missing[--missing_count];
        break;
      }
    }
  }
  closedir(devices);
}

int format_cached_process_tty_name(dev_t dev, char *out, size_t size) {
  if (dev == NODEV) {
    strlcpy(out, "??", size);
    return 1;
  }
  const char *name = cached_tty_name(dev);
  if (name == NULL) {
    return 0;
  }
  strlcpy(out, name, size);
  return 1;
}

void format_process_tty_name(dev_t dev, char *out, size_t size) {
  if (format_cached_process_tty_name(dev, out, size)) {
    return;
  }
  char name_buffer[MAXNAMLEN];
  const char *name = devname_r(dev, S_IFCHR, name_buffer, sizeof(name_buffer));
  strlcpy(out, name != NULL ? name : "??", size);
  if (name != NULL) {
    cache_tty_name(dev, name);
  }
}
