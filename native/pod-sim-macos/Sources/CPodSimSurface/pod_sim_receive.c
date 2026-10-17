// The reference receiver of the frame wire, for tests and probes. Its admission is PodNative's
// browser receiver's (Sources/CPodBrowserSurface in pod-native): a code requirement checked once
// per sender process from the audit trailer (or, in tests, one process), then the stream's nonce.
// Every message it does not hand over is destroyed with its rights.
#include "pod_sim_surface.h"

#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurfaceRef.h>
#include <Security/Security.h>
#include <bsm/libbsm.h>
#include <os/lock.h>
#include <pthread.h>
#include <servers/bootstrap.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#define VERDICT_CACHE 16

typedef struct {
    pid_t pid;
    int pidversion;
    bool admitted;
} verdict;

struct pod_sim_receiver {
    mach_port_t port;
    pthread_t thread;
    pod_sim_frame_handler handler;
    void *context;
    os_unfair_lock lock;
    SecRequirementRef requirement;
    // Tests only: the one process admitted instead of a requirement (pid 0: none).
    pid_t admitted_pid;
    int admitted_pidversion;
    verdict verdicts[VERDICT_CACHE];
    int next_verdict;
    _Atomic uint64_t nonce;
    _Atomic bool stopping;
    _Atomic uint64_t received;
    _Atomic uint64_t admitted;
    _Atomic uint64_t refused;
    _Atomic uint64_t stale;
    _Atomic uint64_t malformed;
};

static bool code_meets(audit_token_t token, SecRequirementRef requirement) {
    CFDataRef data = CFDataCreate(NULL, (const UInt8 *)&token, sizeof(token));
    const void *keys[] = {kSecGuestAttributeAudit};
    const void *values[] = {data};
    CFDictionaryRef attributes =
        CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    SecCodeRef code = NULL;
    bool meets = SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code) == errSecSuccess &&
                 SecCodeCheckValidity(code, kSecCSDefaultFlags, requirement) == errSecSuccess;
    if (code) CFRelease(code);
    CFRelease(attributes);
    CFRelease(data);
    return meets;
}

static bool admits(pod_sim_receiver *receiver, audit_token_t token) {
    pid_t pid = audit_token_to_pid(token);
    int pidversion = audit_token_to_pidversion(token);
    os_unfair_lock_lock(&receiver->lock);
    if (receiver->admitted_pid != 0) {
        // The pidversion tells this process from a later one that got the same pid.
        bool same = receiver->admitted_pid == pid && receiver->admitted_pidversion == pidversion;
        os_unfair_lock_unlock(&receiver->lock);
        return same;
    }
    SecRequirementRef requirement = receiver->requirement;
    if (!requirement) {
        os_unfair_lock_unlock(&receiver->lock);
        return false;
    }
    for (int i = 0; i < VERDICT_CACHE; i++) {
        verdict known = receiver->verdicts[i];
        if (known.pid == pid && known.pidversion == pidversion && pid != 0) {
            os_unfair_lock_unlock(&receiver->lock);
            return known.admitted;
        }
    }
    CFRetain(requirement);
    os_unfair_lock_unlock(&receiver->lock);
    bool admitted = code_meets(token, requirement);
    os_unfair_lock_lock(&receiver->lock);
    if (receiver->requirement == requirement) {
        receiver->verdicts[receiver->next_verdict] = (verdict){pid, pidversion, admitted};
        receiver->next_verdict = (receiver->next_verdict + 1) % VERDICT_CACHE;
    }
    os_unfair_lock_unlock(&receiver->lock);
    CFRelease(requirement);
    return admitted;
}

typedef union {
    struct {
        pod_sim_surface_msg_t msg;
        mach_msg_audit_trailer_t trailer;
    } surface;
    struct {
        pod_sim_frame_msg_t msg;
        mach_msg_audit_trailer_t trailer;
    } frame;
    uint8_t bytes[sizeof(pod_sim_surface_msg_t) + sizeof(mach_msg_audit_trailer_t) + 64];
} receive_buffer;

static void *receive_loop(void *argument) {
    pod_sim_receiver *receiver = argument;
    while (!atomic_load(&receiver->stopping)) {
        receive_buffer buffer;
        mach_msg_header_t *header = (mach_msg_header_t *)buffer.bytes;
        kern_return_t kr = mach_msg(header,
                                    MACH_RCV_MSG | MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) |
                                        MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
                                    0, sizeof(buffer), receiver->port, MACH_MSG_TIMEOUT_NONE, MACH_PORT_NULL);
        uint64_t received_at = pod_sim_now_ns();
        // The receive right is gone: nothing will ever arrive again.
        if (kr == MACH_RCV_PORT_DIED || kr == MACH_RCV_INVALID_NAME) break;
        if (kr != KERN_SUCCESS) {
            atomic_fetch_add(&receiver->malformed, 1);
            continue;
        }
        atomic_fetch_add(&receiver->received, 1);
        bool complex = (header->msgh_bits & MACH_MSGH_BITS_COMPLEX) != 0;
        bool is_surface = header->msgh_id == POD_SIM_SURFACE_MSG_ID && complex &&
                          header->msgh_size == sizeof(pod_sim_surface_msg_t) &&
                          buffer.surface.msg.body.msgh_descriptor_count == 1 &&
                          buffer.surface.msg.surface.type == MACH_MSG_PORT_DESCRIPTOR &&
                          buffer.surface.msg.surface.disposition == MACH_MSG_TYPE_PORT_SEND &&
                          buffer.surface.msg.version == POD_SIM_WIRE_VERSION;
        bool is_frame = header->msgh_id == POD_SIM_FRAME_MSG_ID && !complex &&
                        header->msgh_size == sizeof(pod_sim_frame_msg_t) &&
                        buffer.frame.msg.version == POD_SIM_WIRE_VERSION;
        if (!is_surface && !is_frame) {
            mach_msg_destroy(header);
            atomic_fetch_add(&receiver->malformed, 1);
            continue;
        }
        mach_msg_audit_trailer_t *trailer =
            (mach_msg_audit_trailer_t *)((uint8_t *)header + round_msg(header->msgh_size));
        if (!admits(receiver, trailer->msgh_audit)) {
            mach_msg_destroy(header);
            atomic_fetch_add(&receiver->refused, 1);
            continue;
        }
        uint64_t nonce = is_surface ? buffer.surface.msg.nonce : buffer.frame.msg.nonce;
        uint64_t expected = atomic_load(&receiver->nonce);
        if (expected == 0 || nonce != expected) {
            mach_msg_destroy(header);
            atomic_fetch_add(&receiver->stale, 1);
            continue;
        }
        pod_sim_frame_info info;
        memset(&info, 0, sizeof(info));
        info.received_at_ns = received_at;
        info.sender_pid = audit_token_to_pid(trailer->msgh_audit);
        info.nonce = nonce;
        IOSurfaceRef surface = NULL;
        if (is_surface) {
            pod_sim_surface_msg_t *msg = &buffer.surface.msg;
            surface = IOSurfaceLookupFromMachPort(msg->surface.name);
            info.kind = POD_SIM_SURFACE_MSG_ID;
            info.token = msg->token;
            info.seq = msg->seq;
            info.sent_at_ns = msg->sent_at_ns;
            info.surface_id = msg->surface_id;
            info.width = msg->width;
            info.height = msg->height;
            info.scale_x100 = msg->scale_x100;
            info.seed = msg->seed;
        } else {
            pod_sim_frame_msg_t *msg = &buffer.frame.msg;
            info.kind = POD_SIM_FRAME_MSG_ID;
            info.token = msg->token;
            info.seq = msg->seq;
            info.sent_at_ns = msg->sent_at_ns;
            info.surface_id = msg->surface_id;
            info.seed = msg->seed;
            info.flags = msg->flags;
            info.damage_x = msg->damage_x;
            info.damage_y = msg->damage_y;
            info.damage_width = msg->damage_width;
            info.damage_height = msg->damage_height;
        }
        // The surface keeps its own reference; the message's right (and any other) goes.
        mach_msg_destroy(header);
        if (is_surface && !surface) {
            atomic_fetch_add(&receiver->malformed, 1);
            continue;
        }
        atomic_fetch_add(&receiver->admitted, 1);
        receiver->handler(receiver->context, (void *)surface, &info);
    }
    return NULL;
}

pod_sim_receiver *pod_sim_receiver_start(const char *name, pod_sim_frame_handler handler, void *context, int *error) {
    pod_sim_receiver *receiver = calloc(1, sizeof(*receiver));
    if (!receiver) {
        if (error) *error = KERN_RESOURCE_SHORTAGE;
        return NULL;
    }
    receiver->lock = OS_UNFAIR_LOCK_INIT;
    kern_return_t kr = bootstrap_check_in(bootstrap_port, name, &receiver->port);
    if (kr != KERN_SUCCESS) {
        free(receiver);
        if (error) *error = kr;
        return NULL;
    }
    receiver->handler = handler;
    receiver->context = context;
    pthread_attr_t attributes;
    pthread_attr_init(&attributes);
    pthread_attr_set_qos_class_np(&attributes, QOS_CLASS_USER_INTERACTIVE, 0);
    int created = pthread_create(&receiver->thread, &attributes, receive_loop, receiver);
    pthread_attr_destroy(&attributes);
    if (created != 0) {
        mach_port_mod_refs(mach_task_self(), receiver->port, MACH_PORT_RIGHT_RECEIVE, -1);
        free(receiver);
        if (error) *error = KERN_FAILURE;
        return NULL;
    }
    if (error) *error = 0;
    return receiver;
}

static void admit(pod_sim_receiver *receiver, SecRequirementRef requirement, pid_t pid, int pidversion) {
    os_unfair_lock_lock(&receiver->lock);
    SecRequirementRef previous = receiver->requirement;
    receiver->requirement = requirement;
    receiver->admitted_pid = pid;
    receiver->admitted_pidversion = pidversion;
    memset(receiver->verdicts, 0, sizeof(receiver->verdicts));
    receiver->next_verdict = 0;
    os_unfair_lock_unlock(&receiver->lock);
    if (previous) CFRelease(previous);
}

void pod_sim_receiver_admit(pod_sim_receiver *receiver, const char *requirement) {
    SecRequirementRef compiled = NULL;
    if (requirement) {
        CFStringRef text = CFStringCreateWithCString(NULL, requirement, kCFStringEncodingUTF8);
        if (text) {
            if (SecRequirementCreateWithString(text, kSecCSDefaultFlags, &compiled) != errSecSuccess) compiled = NULL;
            CFRelease(text);
        }
    }
    admit(receiver, compiled, 0, 0);
}

void pod_sim_receiver_admit_self(pod_sim_receiver *receiver) {
    audit_token_t token;
    mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
    if (task_info(mach_task_self(), TASK_AUDIT_TOKEN, (task_info_t)&token, &count) != KERN_SUCCESS) {
        admit(receiver, NULL, 0, 0);
        return;
    }
    admit(receiver, NULL, audit_token_to_pid(token), audit_token_to_pidversion(token));
}

void pod_sim_receiver_expect(pod_sim_receiver *receiver, uint64_t nonce) { atomic_store(&receiver->nonce, nonce); }

pod_sim_receiver_counts pod_sim_receiver_get_counts(pod_sim_receiver *receiver) {
    return (pod_sim_receiver_counts){
        .received = atomic_load(&receiver->received),
        .admitted = atomic_load(&receiver->admitted),
        .refused = atomic_load(&receiver->refused),
        .stale = atomic_load(&receiver->stale),
        .malformed = atomic_load(&receiver->malformed),
    };
}

void pod_sim_receiver_stop(pod_sim_receiver *receiver) {
    if (!receiver) return;
    atomic_store(&receiver->stopping, true);
    // The receive thread wakes with MACH_RCV_PORT_DIED; queued messages and their rights go with the port.
    mach_port_mod_refs(mach_task_self(), receiver->port, MACH_PORT_RIGHT_RECEIVE, -1);
    pthread_join(receiver->thread, NULL);
    if (receiver->requirement) CFRelease(receiver->requirement);
    free(receiver);
}
