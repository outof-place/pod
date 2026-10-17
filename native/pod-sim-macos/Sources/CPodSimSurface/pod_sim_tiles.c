#include "pod_sim_surface.h"

#include <IOSurface/IOSurfaceRef.h>
#include <string.h>

#define MIX_K 0x9E3779B97F4A7C15ull

// The rotation carries a change in a word's top bits down, so the next multiply spreads it.
static inline uint64_t mix(uint64_t h, uint64_t w) {
    uint64_t x = (h ^ w) * MIX_K;
    return (x << 31) | (x >> 33);
}

static inline uint64_t load64(const uint8_t *p) {
    uint64_t w;
    memcpy(&w, p, sizeof(w));
    return w;
}

// Four lanes per row segment, so the multiplies do not wait on each other.
static uint64_t segment_hash(const uint8_t *p, size_t bytes) {
    uint64_t a = 0x243F6A8885A308D3ull, b = 0x13198A2E03707344ull, c = 0xA4093822299F31D0ull,
             d = 0x082EFA98EC4E6C89ull;
    size_t words = bytes / 8, i = 0;
    for (; i + 4 <= words; i += 4) {
        a = mix(a, load64(p + 8 * i));
        b = mix(b, load64(p + 8 * (i + 1)));
        c = mix(c, load64(p + 8 * (i + 2)));
        d = mix(d, load64(p + 8 * (i + 3)));
    }
    for (; i < words; i++) a = mix(a, load64(p + 8 * i));
    size_t tail = bytes % 8;
    if (tail) {
        uint64_t w = 0;
        memcpy(&w, p + 8 * words, tail);
        b = mix(b, w);
    }
    return mix(mix(mix(a, b), c), d);
}

void pod_sim_tile_hashes_buffer(const uint8_t *pixels, size_t width, size_t height, size_t stride, uint32_t tile,
                                uint64_t *hashes) {
    size_t tiles_x = (width + tile - 1) / tile, tiles_y = (height + tile - 1) / tile;
    for (size_t i = 0; i < tiles_x * tiles_y; i++) hashes[i] = 0x452821E638D01377ull;
    for (size_t y = 0; y < height; y++) {
        const uint8_t *row = pixels + y * stride;
        uint64_t *line = hashes + (y / tile) * tiles_x;
        for (size_t tx = 0; tx < tiles_x; tx++) {
            size_t x0 = tx * tile, x1 = x0 + tile < width ? x0 + tile : width;
            line[tx] = mix(line[tx], segment_hash(row + 4 * x0, 4 * (x1 - x0)));
        }
    }
}

int pod_sim_tile_hashes(void *surface, uint32_t tile, uint64_t *hashes, size_t count, uint32_t *seed_before,
                        uint32_t *seed_after) {
    IOSurfaceRef ref = surface;
    size_t width = IOSurfaceGetWidth(ref), height = IOSurfaceGetHeight(ref);
    if (tile == 0 || IOSurfaceGetBytesPerElement(ref) != 4 || IOSurfaceGetPlaneCount(ref) > 1) return -1;
    if (count < ((width + tile - 1) / tile) * ((height + tile - 1) / tile)) return -1;
    uint32_t before = 0;
    if (IOSurfaceLock(ref, kIOSurfaceLockReadOnly, &before) != KERN_SUCCESS) return -1;
    pod_sim_tile_hashes_buffer(IOSurfaceGetBaseAddress(ref), width, height, IOSurfaceGetBytesPerRow(ref), tile,
                               hashes);
    IOSurfaceUnlock(ref, kIOSurfaceLockReadOnly, NULL);
    if (seed_before) *seed_before = before;
    if (seed_after) *seed_after = IOSurfaceGetSeed(ref);
    return 0;
}
