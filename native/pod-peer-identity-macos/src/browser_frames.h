// Fork-only (Pod): one browser frame from this runtime to PodNative, the page's IOSurface as a Mach
// send right. PodNative's CPodBrowserSurface (pod_browser_frame.h) receives exactly this struct;
// change both together.
#pragma once

#include <mach/mach.h>
#include <node_api.h>
#include <stdint.h>

#define POD_BROWSER_FRAME_MSG_ID 0x504f4402

enum {
  POD_BROWSER_WIDGET_PAGE = 0,
  POD_BROWSER_WIDGET_POPUP = 1,
};

typedef struct {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t surface;
  uint64_t seq;
  // clock_gettime_nsec_np(CLOCK_UPTIME_RAW), right before mach_msg.
  uint64_t sent_at_ns;
  uint32_t token;
  uint32_t widget;
  uint32_t surface_id;
  // Pixels.
  uint32_t width;
  uint32_t height;
  // CSS px, popups only.
  int32_t popup_x;
  int32_t popup_y;
  // Device scale × 100.
  uint32_t scale_x100;
} pod_browser_frame_msg_t;

/** Adds browserConnect / browserDisconnect / browserSend / browserNow to `exports`. */
void pod_browser_frames_register(napi_env env, napi_value exports);
