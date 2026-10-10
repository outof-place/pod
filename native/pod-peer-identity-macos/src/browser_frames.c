// Fork-only (Pod): sends an offscreen browser page's frames to PodNative. Electron's shared texture
// handle is an IOSurfaceRef local to this process; IOSurfaceCreateMachPort is what lets PodNative
// map the same memory. PodNative checks the sender's code signature from the message's audit
// trailer, so this side only needs the rendezvous name PodNative handed over the ui-host socket.
#include "browser_frames.h"

#include <IOSurface/IOSurfaceRef.h>
#include <servers/bootstrap.h>
#include <string.h>
#include <time.h>

static mach_port_t service = MACH_PORT_NULL;

static napi_value make_bool(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

static napi_value make_double(napi_env env, double value) {
  napi_value result;
  napi_create_double(env, value, &result);
  return result;
}

static void drop_service(void) {
  if (service != MACH_PORT_NULL) {
    mach_port_deallocate(mach_task_self(), service);
    service = MACH_PORT_NULL;
  }
}

// browserConnect(name): looks PodNative's rendezvous name up; false when nobody checked it in.
static napi_value browser_connect(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char name[128];
  size_t length = 0;
  if (argc < 1 ||
      napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &length) != napi_ok ||
      length == 0 || length >= sizeof(name) - 1) {
    return make_bool(env, false);
  }
  drop_service();
  return make_bool(env, bootstrap_look_up(bootstrap_port, name, &service) == KERN_SUCCESS);
}

static napi_value browser_disconnect(napi_env env, napi_callback_info info) {
  (void)info;
  drop_service();
  return make_bool(env, true);
}

static bool get_uint32(napi_env env, napi_value object, const char *key, uint32_t *out) {
  napi_value value;
  return napi_get_named_property(env, object, key, &value) == napi_ok &&
         napi_get_value_uint32(env, value, out) == napi_ok;
}

static bool get_int32(napi_env env, napi_value object, const char *key, int32_t *out) {
  napi_value value;
  return napi_get_named_property(env, object, key, &value) == napi_ok &&
         napi_get_value_int32(env, value, out) == napi_ok;
}

// browserSend(ioSurfaceHandle, { seq, token, widget, popupX, popupY, scaleX100 }) -> { ok, ns }
static napi_value browser_send(napi_env env, napi_callback_info info) {
  uint64_t started = clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void *data = NULL;
  size_t length = 0;
  uint32_t seq = 0, token = 0, widget = 0, scale = 100;
  int32_t popup_x = 0, popup_y = 0;
  bool ok = false;
  if (argc == 2 && service != MACH_PORT_NULL &&
      napi_get_buffer_info(env, argv[0], &data, &length) == napi_ok &&
      length >= sizeof(IOSurfaceRef) && get_uint32(env, argv[1], "seq", &seq) &&
      get_uint32(env, argv[1], "token", &token) && get_uint32(env, argv[1], "widget", &widget) &&
      get_int32(env, argv[1], "popupX", &popup_x) && get_int32(env, argv[1], "popupY", &popup_y) &&
      get_uint32(env, argv[1], "scaleX100", &scale)) {
    IOSurfaceRef surface;
    memcpy(&surface, data, sizeof(surface));
    mach_port_t port = IOSurfaceCreateMachPort(surface);
    if (port != MACH_PORT_NULL) {
      pod_browser_frame_msg_t msg;
      memset(&msg, 0, sizeof(msg));
      msg.header.msgh_bits =
          MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, MACH_MSGH_BITS_COMPLEX);
      msg.header.msgh_size = sizeof(msg);
      msg.header.msgh_remote_port = service;
      msg.header.msgh_id = POD_BROWSER_FRAME_MSG_ID;
      msg.body.msgh_descriptor_count = 1;
      msg.surface.name = port;
      msg.surface.disposition = MACH_MSG_TYPE_MOVE_SEND;
      msg.surface.type = MACH_MSG_PORT_DESCRIPTOR;
      msg.seq = seq;
      msg.token = token;
      msg.widget = widget;
      msg.surface_id = IOSurfaceGetID(surface);
      msg.width = (uint32_t)IOSurfaceGetWidth(surface);
      msg.height = (uint32_t)IOSurfaceGetHeight(surface);
      msg.popup_x = popup_x;
      msg.popup_y = popup_y;
      msg.scale_x100 = scale;
      msg.sent_at_ns = clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
      // Why a timeout: never block the main process on a PodNative that stopped reading.
      kern_return_t kr = mach_msg(&msg.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof(msg), 0,
                                  MACH_PORT_NULL, 2, MACH_PORT_NULL);
      ok = kr == KERN_SUCCESS;
      if (!ok) {
        // A send that failed hands the moved right back.
        mach_port_deallocate(mach_task_self(), port);
        if (kr == MACH_SEND_INVALID_DEST) {
          drop_service();
        }
      }
    }
  }
  napi_value result;
  napi_create_object(env, &result);
  napi_set_named_property(env, result, "ok", make_bool(env, ok));
  napi_set_named_property(
      env, result, "ns",
      make_double(env, (double)(clock_gettime_nsec_np(CLOCK_UPTIME_RAW) - started)));
  return result;
}

// browserNow(): the clock both sides stamp with, in ns.
static napi_value browser_now(napi_env env, napi_callback_info info) {
  (void)info;
  return make_double(env, (double)clock_gettime_nsec_np(CLOCK_UPTIME_RAW));
}

void pod_browser_frames_register(napi_env env, napi_value exports) {
  const struct {
    const char *name;
    napi_callback callback;
  } functions[] = {
      {"browserConnect", browser_connect},
      {"browserDisconnect", browser_disconnect},
      {"browserSend", browser_send},
      {"browserNow", browser_now},
  };
  for (size_t i = 0; i < sizeof(functions) / sizeof(functions[0]); i++) {
    napi_value fn;
    napi_create_function(env, functions[i].name, NAPI_AUTO_LENGTH, functions[i].callback, NULL,
                         &fn);
    napi_set_named_property(env, exports, functions[i].name, fn);
  }
}
