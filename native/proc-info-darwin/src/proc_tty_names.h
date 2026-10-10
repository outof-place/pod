#ifndef ORCA_PROC_TTY_NAMES_H
#define ORCA_PROC_TTY_NAMES_H

#include <stddef.h>
#include <sys/types.h>

struct kinfo_proc;

void preload_process_tty_names(const struct kinfo_proc *procs, size_t count);
int format_cached_process_tty_name(dev_t dev, char *out, size_t size);
void format_process_tty_name(dev_t dev, char *out, size_t size);

#endif
