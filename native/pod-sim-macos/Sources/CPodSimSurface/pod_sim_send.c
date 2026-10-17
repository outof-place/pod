#include "pod_sim_surface.h"

#include <IOSurface/IOSurfaceRef.h>
#include <servers/bootstrap.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

struct pod_sim_sender {
    mach_port_t service;
    uint32_t token;
    uint64_t nonce;
};

uint64_t pod_sim_now_ns(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW); }

pod_sim_sender *pod_sim_sender_create(const char *service, uint32_t token, uint64_t nonce, int *error) {
    mach_port_t port = MACH_PORT_NULL;
    kern_return_t kr = bootstrap_look_up(bootstrap_port, service, &port);
    if (kr != KERN_SUCCESS) {
        if (error) *error = kr;
        return NULL;
    }
    pod_sim_sender *sender = calloc(1, sizeof(*sender));
    if (!sender) {
        mach_port_deallocate(mach_task_self(), port);
        if (error) *error = KERN_RESOURCE_SHORTAGE;
        return NULL;
    }
    sender->service = port;
    sender->token = token;
    sender->nonce = nonce;
    if (error) *error = 0;
    return sender;
}

void pod_sim_sender_destroy(pod_sim_sender *sender) {
    if (!sender) return;
    mach_port_deallocate(mach_task_self(), sender->service);
    free(sender);
}

// A send that timed out or was interrupted had been copied in, and the kernel hands it back
// pseudo-received, every right in it ours again (XNU ipc_kmsg_copyout_pseudo).
static bool returned_with_rights(kern_return_t kr) { return kr == MACH_SEND_TIMED_OUT || kr == MACH_SEND_INTERRUPTED; }

// A zero timeout: a viewer that is behind loses frames, never stalls the frame callback. A message
// that comes back is destroyed, or each dropped one would keep a reference to the viewer's port (and
// a surface message one to a framebuffer).
static kern_return_t send_now(mach_msg_header_t *header, mach_msg_size_t size) {
    kern_return_t kr = mach_msg(header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, size, 0, MACH_PORT_NULL, 0, MACH_PORT_NULL);
    if (returned_with_rights(kr)) mach_msg_destroy(header);
    return kr;
}

int pod_sim_sender_send_surface(pod_sim_sender *sender, void *surface, uint64_t seq, uint32_t scale_x100) {
    IOSurfaceRef ref = surface;
    mach_port_t right = IOSurfaceCreateMachPort(ref);
    if (right == MACH_PORT_NULL) return KERN_FAILURE;
    pod_sim_surface_msg_t msg;
    memset(&msg, 0, sizeof(msg));
    msg.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, MACH_MSGH_BITS_COMPLEX);
    msg.header.msgh_size = sizeof(msg);
    msg.header.msgh_remote_port = sender->service;
    msg.header.msgh_id = POD_SIM_SURFACE_MSG_ID;
    msg.body.msgh_descriptor_count = 1;
    msg.surface.name = right;
    msg.surface.disposition = MACH_MSG_TYPE_MOVE_SEND;
    msg.surface.type = MACH_MSG_PORT_DESCRIPTOR;
    msg.version = POD_SIM_WIRE_VERSION;
    msg.token = sender->token;
    msg.seq = seq;
    msg.surface_id = IOSurfaceGetID(ref);
    msg.width = (uint32_t)IOSurfaceGetWidth(ref);
    msg.height = (uint32_t)IOSurfaceGetHeight(ref);
    msg.scale_x100 = scale_x100;
    msg.seed = IOSurfaceGetSeed(ref);
    msg.nonce = sender->nonce;
    msg.sent_at_ns = pod_sim_now_ns();
    kern_return_t kr = send_now(&msg.header, sizeof(msg));
    // Refused before copy-in (MACH_SEND_INVALID_DEST and the like): the right never moved.
    if (kr != KERN_SUCCESS && !returned_with_rights(kr)) mach_port_deallocate(mach_task_self(), right);
    return kr;
}

int pod_sim_sender_send_frame(pod_sim_sender *sender, uint64_t seq, uint32_t surface_id, uint32_t seed, uint32_t flags,
                              int32_t damage_x, int32_t damage_y, int32_t damage_width, int32_t damage_height) {
    pod_sim_frame_msg_t msg;
    memset(&msg, 0, sizeof(msg));
    msg.header.msgh_bits = MACH_MSGH_BITS_SET(MACH_MSG_TYPE_COPY_SEND, 0, 0, 0);
    msg.header.msgh_size = sizeof(msg);
    msg.header.msgh_remote_port = sender->service;
    msg.header.msgh_id = POD_SIM_FRAME_MSG_ID;
    msg.version = POD_SIM_WIRE_VERSION;
    msg.token = sender->token;
    msg.seq = seq;
    msg.surface_id = surface_id;
    msg.seed = seed;
    msg.flags = flags;
    msg.damage_x = damage_x;
    msg.damage_y = damage_y;
    msg.damage_width = damage_width;
    msg.damage_height = damage_height;
    msg.nonce = sender->nonce;
    msg.sent_at_ns = pod_sim_now_ns();
    return send_now(&msg.header, sizeof(msg));
}
