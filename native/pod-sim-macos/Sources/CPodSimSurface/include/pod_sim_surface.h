// pod-sim's C side of the live view and of screenshots: the frame wire's sender (pod_sim_frame.h),
// a reference receiver for tests and probes (PodNative has its own), the tile hashes settle
// compares, and a PNG encoder that compresses strips in parallel.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#include "pod_sim_frame.h"

// MARK: - sender

typedef struct pod_sim_sender pod_sim_sender;

/// Looks `service` up once (bootstrap_look_up); every send goes to that right, carrying `token` and
/// `nonce`. NULL with the kern_return_t in `error` when no process has checked the name in.
pod_sim_sender *pod_sim_sender_create(const char *service, uint32_t token, uint64_t nonce, int *error);
void pod_sim_sender_destroy(pod_sim_sender *sender);

/// The surface message for `surface` (an IOSurfaceRef). Never blocks: a full receive queue answers
/// MACH_SEND_TIMED_OUT, a receiver that is gone MACH_SEND_INVALID_DEST; 0 on success. A message that
/// was not delivered leaves no right behind.
int pod_sim_sender_send_surface(pod_sim_sender *sender, void *surface, uint64_t seq, uint32_t scale_x100);

/// One frame message; damage in pixels (the whole surface at version 1).
int pod_sim_sender_send_frame(pod_sim_sender *sender, uint64_t seq, uint32_t surface_id, uint32_t seed, uint32_t flags,
                              int32_t damage_x, int32_t damage_y, int32_t damage_width, int32_t damage_height);

uint64_t pod_sim_now_ns(void);

// MARK: - reference receiver (tests, probes)

typedef struct pod_sim_receiver pod_sim_receiver;

typedef struct {
    // POD_SIM_SURFACE_MSG_ID or POD_SIM_FRAME_MSG_ID.
    uint32_t kind;
    uint32_t token;
    uint64_t seq;
    uint64_t sent_at_ns;
    uint64_t received_at_ns;
    uint32_t surface_id;
    uint32_t width;
    uint32_t height;
    uint32_t scale_x100;
    uint32_t seed;
    uint32_t flags;
    int32_t damage_x;
    int32_t damage_y;
    int32_t damage_width;
    int32_t damage_height;
    uint64_t nonce;
    // From the audit trailer: the kernel vouches for it.
    pid_t sender_pid;
} pod_sim_frame_info;

/// `surface` is an IOSurfaceRef the handler owns (+1) for a surface message, NULL for a frame
/// message. Called on the receive thread, only for admitted senders and the expected nonce.
typedef void (*pod_sim_frame_handler)(void *context, void *surface, const pod_sim_frame_info *info);

typedef struct {
    uint64_t received;
    // Handed to the handler.
    uint64_t admitted;
    // From a sender that is not admitted.
    uint64_t refused;
    // From an admitted sender, with another nonce than the expected one (or none expected yet).
    uint64_t stale;
    uint64_t malformed;
} pod_sim_receiver_counts;

/// Checks `name` in with launchd and receives on a thread of its own. Admits nobody until
/// pod_sim_receiver_admit, and keeps nothing until pod_sim_receiver_expect. NULL with the
/// kern_return_t in `error` on failure.
pod_sim_receiver *pod_sim_receiver_start(const char *name, pod_sim_frame_handler handler, void *context, int *error);
/// Senders meeting `requirement`, checked once per process (pid and pidversion).
void pod_sim_receiver_admit(pod_sim_receiver *receiver, const char *requirement);
/// Tests only: this process (its pid and pidversion) instead of a requirement.
void pod_sim_receiver_admit_self(pod_sim_receiver *receiver);
/// The stream to keep: messages carrying another nonce are destroyed (`stale`).
void pod_sim_receiver_expect(pod_sim_receiver *receiver, uint64_t nonce);
pod_sim_receiver_counts pod_sim_receiver_get_counts(pod_sim_receiver *receiver);
/// Destroys the receive right (the name with it), waits for the receive thread to end, frees the
/// receiver. The right is the receiver's: destroy it only through this.
void pod_sim_receiver_stop(pod_sim_receiver *receiver);

// MARK: - tiles (settle)

/// One 64-bit hash per `tile` x `tile` pixel tile of a 4-byte-per-pixel surface, row-major,
/// ceil(width / tile) x ceil(height / tile) of them, read-locked. Seeds before and after the read go
/// to `seed_before` and `seed_after`. -1 when `count` is too small or the surface has another format.
int pod_sim_tile_hashes(void *surface, uint32_t tile, uint64_t *hashes, size_t count, uint32_t *seed_before,
                        uint32_t *seed_after);

/// The same over a plain BGRA buffer (tests).
void pod_sim_tile_hashes_buffer(const uint8_t *pixels, size_t width, size_t height, size_t stride, uint32_t tile,
                                uint64_t *hashes);

// MARK: - PNG

/// Encodes BGRA pixels (top row first) as an 8-bit RGB PNG tagged sRGB: rows filtered Sub, strips
/// deflated at level 1 in parallel and joined into one zlib stream. `*out` is malloc'd. 0 on success.
int pod_sim_png_encode(const uint8_t *bgra, size_t width, size_t height, size_t stride, uint8_t **out,
                       size_t *out_size);
