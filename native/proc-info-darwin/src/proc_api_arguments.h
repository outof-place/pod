#ifndef ORCA_PROC_API_ARGUMENTS_H
#define ORCA_PROC_API_ARGUMENTS_H

#include <node_api.h>
#include <stddef.h>
#include <stdint.h>

typedef enum {
  PROC_TTY_ARGUMENT_ERROR,
  PROC_TTY_ARGUMENT_PRESENT,
  PROC_TTY_ARGUMENT_ABSENT
} proc_tty_argument_status;

int read_process_pid_argument(napi_env env, napi_callback_info info, int32_t *pid);
proc_tty_argument_status read_process_tty_argument(
    napi_env env, napi_callback_info info, size_t index, int optional, char *out, size_t size);

#endif
