// Fork-only (Pod): who is on the other end of a unix socket. The one-app control socket admits only
// PodNative signed by Pod's team; Node has no API for the peer's audit token, so this reads it
// (LOCAL_PEERTOKEN) and checks its code signature against a requirement (Security framework).
//
//   checkPeer(fd: number, requirement: string) -> { ok: boolean, pid: number, error?: string }
#include "browser_frames.h"

#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <bsm/libbsm.h>
#include <node_api.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>

static napi_value make_result(napi_env env, bool ok, int pid, const char *error) {
  napi_value result, value;
  napi_create_object(env, &result);
  napi_get_boolean(env, ok, &value);
  napi_set_named_property(env, result, "ok", value);
  napi_create_int32(env, pid, &value);
  napi_set_named_property(env, result, "pid", value);
  if (error) {
    napi_create_string_utf8(env, error, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, result, "error", value);
  }
  return result;
}

static napi_value check_peer(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) {
    napi_throw_type_error(env, NULL, "checkPeer(fd, requirement)");
    return NULL;
  }
  int32_t fd = -1;
  if (napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "fd must be a non-negative integer");
    return NULL;
  }
  char requirement_text[1024];
  size_t requirement_length = 0;
  if (napi_get_value_string_utf8(env, argv[1], requirement_text, sizeof(requirement_text),
                                 &requirement_length) != napi_ok ||
      requirement_length == 0 || requirement_length >= sizeof(requirement_text) - 1) {
    napi_throw_type_error(env, NULL, "requirement must be a non-empty string under 1 KiB");
    return NULL;
  }

  audit_token_t token;
  socklen_t token_length = sizeof(token);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &token_length) != 0 ||
      token_length != sizeof(token)) {
    return make_result(env, false, 0, "no peer audit token");
  }
  int pid = audit_token_to_pid(token);

  CFDataRef token_data = CFDataCreate(NULL, (const UInt8 *)&token, sizeof(token));
  const void *keys[] = {kSecGuestAttributeAudit};
  const void *values[] = {token_data};
  CFDictionaryRef attributes =
      CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
                         &kCFTypeDictionaryValueCallBacks);
  CFRelease(token_data);
  SecCodeRef code = NULL;
  OSStatus status = SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code);
  CFRelease(attributes);
  if (status != errSecSuccess || code == NULL) {
    return make_result(env, false, pid, "peer code not found");
  }

  CFStringRef requirement_string =
      CFStringCreateWithCString(NULL, requirement_text, kCFStringEncodingUTF8);
  SecRequirementRef requirement = NULL;
  status = requirement_string
               ? SecRequirementCreateWithString(requirement_string, kSecCSDefaultFlags, &requirement)
               : errSecParam;
  if (requirement_string) {
    CFRelease(requirement_string);
  }
  if (status != errSecSuccess || requirement == NULL) {
    CFRelease(code);
    return make_result(env, false, pid, "invalid requirement");
  }
  // Why the dynamic check: it covers the running process (its pages), not only the file on disk.
  status = SecCodeCheckValidity(code, kSecCSDefaultFlags, requirement);
  CFRelease(requirement);
  CFRelease(code);
  if (status != errSecSuccess) {
    char message[64];
    snprintf(message, sizeof(message), "peer fails the requirement (%d)", (int)status);
    return make_result(env, false, pid, message);
  }
  return make_result(env, true, pid, NULL);
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "checkPeer", NAPI_AUTO_LENGTH, check_peer, NULL, &fn);
  napi_set_named_property(env, exports, "checkPeer", fn);
  // The browser pane's frame sender rides in the same addon: one native module to package.
  pod_browser_frames_register(env, exports);
  return exports;
}
