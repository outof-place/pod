// A PNG of a framebuffer in a few milliseconds: ImageIO's encoder took 21 to 69 ms (p50) on four
// 1206x2622 device screens, this one 5 to 18 ms. Strips are filtered and deflated concurrently with a
// sync flush between them and joined into one zlib stream, as pigz does; adler32 is combined.
#include "pod_sim_surface.h"

#include <dispatch/dispatch.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

#define PNG_STRIPS 16

typedef struct {
    uint8_t *data;
    size_t size;
    size_t raw;
    uint32_t adler;
    bool failed;
} strip;

static void put32(uint8_t *p, uint32_t value) {
    p[0] = (uint8_t)(value >> 24);
    p[1] = (uint8_t)(value >> 16);
    p[2] = (uint8_t)(value >> 8);
    p[3] = (uint8_t)value;
}

// One chunk: length, type, data, CRC over type and data. Returns the byte after it.
static uint8_t *chunk(uint8_t *p, const char type[4], const uint8_t *data, uint32_t length) {
    put32(p, length);
    memcpy(p + 4, type, 4);
    if (length) memcpy(p + 8, data, length);
    put32(p + 8 + length, (uint32_t)crc32(0, p + 4, 4 + length));
    return p + 12 + length;
}

// Filter type 1 (Sub) per row: each byte minus the same channel of the pixel to its left.
static void filter_rows(const uint8_t *bgra, size_t width, size_t stride, size_t y0, size_t y1, uint8_t *out) {
    size_t row_bytes = 1 + 3 * width;
    for (size_t y = y0; y < y1; y++) {
        const uint8_t *src = bgra + y * stride;
        uint8_t *dst = out + (y - y0) * row_bytes;
        *dst++ = 1;
        uint8_t pr = 0, pg = 0, pb = 0;
        for (size_t x = 0; x < width; x++) {
            uint8_t b = src[4 * x], g = src[4 * x + 1], r = src[4 * x + 2];
            dst[3 * x] = (uint8_t)(r - pr);
            dst[3 * x + 1] = (uint8_t)(g - pg);
            dst[3 * x + 2] = (uint8_t)(b - pb);
            pr = r;
            pg = g;
            pb = b;
        }
    }
}

int pod_sim_png_encode(const uint8_t *bgra, size_t width, size_t height, size_t stride, uint8_t **out,
                       size_t *out_size) {
    if (!bgra || width == 0 || height == 0 || width > 0x7fffffff || height > 0x7fffffff) return -1;
    size_t rows_per = (height + PNG_STRIPS - 1) / PNG_STRIPS;
    size_t strips = (height + rows_per - 1) / rows_per;
    strip *parts = calloc(strips, sizeof(strip));
    if (!parts) return -1;
    size_t row_bytes = 1 + 3 * width;
    dispatch_apply(strips, DISPATCH_APPLY_AUTO, ^(size_t s) {
        size_t y0 = s * rows_per, y1 = y0 + rows_per < height ? y0 + rows_per : height;
        size_t raw_size = (y1 - y0) * row_bytes;
        uint8_t *raw = malloc(raw_size);
        z_stream z;
        memset(&z, 0, sizeof(z));
        if (!raw || deflateInit2(&z, 1, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY) != Z_OK) {
            free(raw);
            parts[s].failed = true;
            return;
        }
        filter_rows(bgra, width, stride, y0, y1, raw);
        size_t capacity = deflateBound(&z, raw_size) + 16;
        uint8_t *packed = malloc(capacity);
        if (packed) {
            z.next_in = raw;
            z.avail_in = (uInt)raw_size;
            z.next_out = packed;
            z.avail_out = (uInt)capacity;
            // The last strip ends the stream; the others end on a byte boundary so they join.
            int status = deflate(&z, s == strips - 1 ? Z_FINISH : Z_SYNC_FLUSH);
            parts[s].failed = s == strips - 1 ? status != Z_STREAM_END : status != Z_OK;
            parts[s].data = packed;
            parts[s].size = capacity - z.avail_out;
        } else {
            parts[s].failed = true;
        }
        parts[s].raw = raw_size;
        parts[s].adler = (uint32_t)adler32(1L, raw, (uInt)raw_size);
        deflateEnd(&z);
        free(raw);
    });
    size_t idat = 2 + 4;
    bool failed = false;
    for (size_t s = 0; s < strips; s++) {
        idat += parts[s].size;
        failed = failed || parts[s].failed;
    }
    uint8_t *png = failed || idat > 0x7fffffff ? NULL : malloc(8 + 25 + 13 + 12 + idat + 12);
    if (!png) {
        for (size_t s = 0; s < strips; s++) free(parts[s].data);
        free(parts);
        return -1;
    }
    uint8_t *p = png;
    memcpy(p, "\x89PNG\r\n\x1a\n", 8);
    p += 8;
    uint8_t header[13];
    put32(header, (uint32_t)width);
    put32(header + 4, (uint32_t)height);
    // 8 bits, truecolour, deflate, adaptive filtering, no interlace.
    header[8] = 8;
    header[9] = 2;
    header[10] = 0;
    header[11] = 0;
    header[12] = 0;
    p = chunk(p, "IHDR", header, 13);
    // The framebuffer is sRGB (CoreSimulator's own screenshots read it so); intent perceptual.
    uint8_t intent = 0;
    p = chunk(p, "sRGB", &intent, 1);
    put32(p, (uint32_t)idat);
    memcpy(p + 4, "IDAT", 4);
    uint8_t *d = p + 8;
    // zlib header: deflate, 32 KB window, fastest level.
    *d++ = 0x78;
    *d++ = 0x01;
    uLong adler = 1;
    for (size_t s = 0; s < strips; s++) {
        memcpy(d, parts[s].data, parts[s].size);
        d += parts[s].size;
        adler = s == 0 ? parts[0].adler : adler32_combine(adler, parts[s].adler, (z_off_t)parts[s].raw);
        free(parts[s].data);
    }
    free(parts);
    put32(d, (uint32_t)adler);
    d += 4;
    put32(d, (uint32_t)crc32(0, p + 4, (uInt)(4 + idat)));
    p = chunk(d + 4, "IEND", NULL, 0);
    *out = png;
    *out_size = (size_t)(p - png);
    return 0;
}
