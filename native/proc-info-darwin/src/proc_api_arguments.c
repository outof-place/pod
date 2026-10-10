#include "proc_api_arguments.h"

#include <math.h>
#include <string.h>

int read_process_pid_argument(napi_env env, napi_callback_info info, int32_t *pid) {
  size_t argc = 1;
  napi_value argv[1];
  double value;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 ||
      napi_get_value_double(env, argv[0], &value) != napi_ok || !isfinite(value) ||
      value < 1 || value > INT32_MAX || floor(value) != value) {
    napi_throw_type_error(env, "ORCA_PROC_INFO_ARGUMENT", "expected a positive pid");
    return 0;
  }
  *pid = (int32_t)value;
  return 1;
}

proc_tty_argument_status read_process_tty_argument(
    napi_env env, napi_callback_info info, size_t index, int optional, char *out, size_t size) {
  size_t argc = 2;
  napi_value argv[2];
  napi_valuetype type = napi_undefined;
  size_t length = 0;
  if (index >= argc || napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) {
    goto invalid;
  }
  if (argc > index && napi_typeof(env, argv[index], &type) != napi_ok) {
    goto invalid;
  }
  if (optional && type == napi_undefined) {
    return PROC_TTY_ARGUMENT_ABSENT;
  }
  if (type != napi_string ||
      napi_get_value_string_utf8(env, argv[index], NULL, 0, &length) != napi_ok ||
      length == 0 || length >= size ||
      napi_get_value_string_utf8(env, argv[index], out, size, &length) != napi_ok ||
      strlen(out) != length) {
    goto invalid;
  }
  return PROC_TTY_ARGUMENT_PRESENT;

invalid:
  napi_throw_type_error(env, "ORCA_PROC_INFO_ARGUMENT", "expected a terminal name");
  return PROC_TTY_ARGUMENT_ERROR;
}
