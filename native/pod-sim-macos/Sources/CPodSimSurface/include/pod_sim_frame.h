// The simulator frame wire from pod-sim to a viewer (PodNative's simulator tab): the device's own
// framebuffer IOSurface as a Mach send right, then one small message per frame. Version 1, settled
// for stage 8; PodNative's receiver mirrors these structs byte for byte, so change both together.
//
// Rendezvous: the viewer checks a name in with launchd (`bootstrap_check_in`, no plist), matching
// `^codes\.pod\.native(\.dev)?\.sim\.[0-9a-f]{32}$`, and hands it to the runtime (ui-host
// `simRendezvous`); the runtime asks the helper to stream a device there (`startStream`) with the
// tab's token and a random 64-bit nonce it gives the viewer too. The viewer admits only senders
// meeting the code requirement
//   anchor apple generic and certificate leaf[subject.OU] = "75Y2KR6P5W" and identifier "codes.pod.sim"
// (checked once per sender process from the message's audit trailer), then keeps a message only when
// its nonce is the one it was given: another sender that meets the requirement and learned the name
// still cannot feed it frames. Admitting one process (pid and pidversion) instead is for tests only.
//
// Order on one stream: a surface message first, and again whenever the device's surface changes
// (reboot, a new framebuffer) or the stream restarts; then a frame message per presented frame. The
// surface is CoreSimulator's own, rewritten in place: a frame message says "frame `seq` is complete
// in the surface as of seed `seed`". A viewer that shows a frame without tearing copies the surface
// (a GPU blit) and keeps the copy only when IOSurfaceGetSeed() equals `seed` both before and after
// the copy; otherwise it drops it, because a newer frame message is already on its way. Nothing is
// sent while the screen is static.
//
// Each message's rights belong to the viewer once received: it destroys every message it does not
// keep (mach_msg_destroy), and accepts the surface only as a send right (MACH_MSG_TYPE_PORT_SEND).
#pragma once

#include <mach/mach.h>
#include <stdint.h>

#define POD_SIM_WIRE_VERSION 1u
#define POD_SIM_SURFACE_MSG_ID 0x504f5331u
#define POD_SIM_FRAME_MSG_ID 0x504f5332u

enum {
    // Reserved, never set at version 1: the damage rectangle is always the whole surface, because
    // CoreSimulator reports no damage geometry (an empty array on CoreSimulator 1171.7).
    POD_SIM_FRAME_DAMAGE_EXACT = 1u << 0,
};

typedef struct {
    mach_msg_header_t header;
    mach_msg_body_t body;
    // The framebuffer IOSurface; IOSurfaceLookupFromMachPort() on the viewer's side.
    mach_msg_port_descriptor_t surface;
    uint32_t version;
    // The stream's token (the ui-host `simAttach` token): which tab the frames are for.
    uint32_t token;
    // The stream's frame counter when this was sent: 0 before the first frame.
    uint64_t seq;
    // clock_gettime_nsec_np(CLOCK_UPTIME_RAW) in the helper, right before mach_msg.
    uint64_t sent_at_ns;
    uint32_t surface_id;
    // Pixels, the device's native (portrait) orientation.
    uint32_t width;
    uint32_t height;
    // Device scale x 100 (300 for @3x): pixels per point.
    uint32_t scale_x100;
    // IOSurfaceGetSeed() when sent.
    uint32_t seed;
    uint32_t reserved;
    // The stream's nonce (`startStream`'s, never 0): the viewer drops a message with another one.
    uint64_t nonce;
} pod_sim_surface_msg_t;

typedef struct {
    mach_msg_header_t header;
    uint32_t version;
    uint32_t token;
    // 1 for the first frame after the stream started, then one more per frame.
    uint64_t seq;
    uint64_t sent_at_ns;
    // The surface this frame is in; a frame for another id than the last surface message is stale.
    uint32_t surface_id;
    // IOSurfaceGetSeed() in the helper's frame callback: the surface holds this frame while the
    // seed still reads this value.
    uint32_t seed;
    uint32_t flags;
    // Pixels, origin top left: the whole surface at version 1.
    int32_t damage_x;
    int32_t damage_y;
    int32_t damage_width;
    int32_t damage_height;
    uint32_t reserved;
    uint64_t nonce;
} pod_sim_frame_msg_t;

_Static_assert(sizeof(pod_sim_surface_msg_t) == 96, "pod_sim_surface_msg_t is fixed at version 1");
_Static_assert(sizeof(pod_sim_frame_msg_t) == 88, "pod_sim_frame_msg_t is fixed at version 1");
_Static_assert(__builtin_offsetof(pod_sim_surface_msg_t, nonce) == 88, "every older field keeps its offset");
_Static_assert(__builtin_offsetof(pod_sim_frame_msg_t, nonce) == 80, "every older field keeps its offset");
