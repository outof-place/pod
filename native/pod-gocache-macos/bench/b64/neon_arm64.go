//go:build goexperiment.simd && arm64

package b64

import "simd/archsimd"

const simdEnabled = true

// Nibble tables from Muła and Lemire, "Faster Base64 Encoding and Decoding using AVX2
// Instructions" (2018), with VTBL in place of PSHUFB. A byte is invalid when
// lutLo[low nibble] & lutHi[high nibble] != 0; lutRoll maps the high nibble ('/' shifted
// down by one) to the offset that turns ASCII into its 6-bit value.
var (
	lutLo   = [16]uint8{0x15, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x13, 0x1a, 0x1b, 0x1b, 0x1b, 0x1a}
	lutHi   = [16]uint8{0x10, 0x10, 0x01, 0x02, 0x04, 0x08, 0x04, 0x08, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10}
	lutRoll = [16]uint8{0, 16, 19, 4, 0xbf, 0xbf, 0xb9, 0xb9, 0, 0, 0, 0, 0, 0, 0, 0}
	// Big-endian 3-byte groups out of little-endian 32-bit lanes; index 0xff yields zero.
	packIdx = [16]uint8{2, 1, 0, 6, 5, 4, 10, 9, 8, 14, 13, 12, 0xff, 0xff, 0xff, 0xff}
)

// decodeBlocks decodes whole 64-byte blocks of pure alphabet text and stops before the first
// block holding anything else ('=', CR/LF, invalid bytes), which the scalar path then handles.
// Everything is spelled out inline with hoisted shift vectors: the compiler keeps a struct of
// constants on the stack and expands ShiftAll* into DUP+USHL per use (seen in objdump).
func decodeBlocks(dst, src []byte) (n, si int) {
	nib := archsimd.BroadcastUint8x16(0x0f)
	slash := archsimd.BroadcastUint8x16('/')
	tLo := archsimd.LoadUint8x16Array(&lutLo)
	tHi := archsimd.LoadUint8x16Array(&lutHi)
	tRoll := archsimd.LoadUint8x16Array(&lutRoll)
	tPack := archsimd.LoadUint8x16Array(&packIdx)
	m6 := archsimd.BroadcastUint16x8(0x003f)
	x64 := archsimd.BroadcastUint16x8(64)
	x4096 := archsimd.BroadcastUint32x4(4096)
	r4 := archsimd.BroadcastInt8x16(-4)
	r8 := archsimd.BroadcastInt16x8(-8)
	r16 := archsimd.BroadcastInt32x4(-16)

	sextets := func(in archsimd.Uint8x16) (vals, bad archsimd.Uint8x16) {
		hi := in.Shift(r4)
		bad = tLo.LookupOrZero(in.And(nib)).And(tHi.LookupOrZero(hi))
		isSlash := in.Equal(slash).ToInt8x16().ToBits()
		return in.Add(tRoll.LookupOrZero(hi.Add(isSlash))), bad
	}
	// 16 sextets -> 12 bytes, left-aligned; the top 4 bytes are zero. Lane bits above 24
	// carry garbage from the 32-bit multiply, but tPack never selects them.
	pack := func(v archsimd.Uint8x16) archsimd.Uint8x16 {
		w := v.ReshapeToUint16s()
		w = w.And(m6).MulAdd(x64, w.Shift(r8))
		d := w.ReshapeToUint32s()
		d = d.MulAdd(x4096, d.Shift(r16))
		return d.ReshapeToUint8s().LookupOrZero(tPack)
	}

	// 4 stores of 16 bytes at a 12-byte stride touch 52 bytes of dst.
	for len(src)-si >= 64 && len(dst)-n >= 52 {
		s := src[si : si+64 : si+64]
		va, ba := sextets(archsimd.LoadUint8x16(s[0:16]))
		vb, bb := sextets(archsimd.LoadUint8x16(s[16:32]))
		vc, bc := sextets(archsimd.LoadUint8x16(s[32:48]))
		vd, bd := sextets(archsimd.LoadUint8x16(s[48:64]))
		if ba.Or(bb).Or(bc).Or(bd).ReduceMax() != 0 {
			break
		}
		d := dst[n : n+52 : n+52]
		pack(va).Store(d[0:16])
		pack(vb).Store(d[12:28])
		pack(vc).Store(d[24:40])
		pack(vd).Store(d[36:52])
		n += 48
		si += 64
	}
	return n, si
}
