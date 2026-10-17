// Fork-only (Pod): Pod Workspace's open-file check.
#ifndef PROC_OPEN_PATHS_H
#define PROC_OPEN_PATHS_H

#include <node_api.h>

napi_value FindOpenPathsUnder(napi_env env, napi_callback_info info);

#endif
