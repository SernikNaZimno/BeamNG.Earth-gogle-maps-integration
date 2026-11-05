// A QR code for the world map's "Send to phone" (the fork's Google Maps integration, phase 0): the Google Maps link of
// a point drawn as a QR code the phone's camera opens. The game's UI cannot load scripts from the internet, so the
// encoder is our own: byte mode, versions 1-10 (up to 213 bytes at level M, a Maps URL is ~60-110), the four error
// correction levels, the mask with the least penalty (ISO/IEC 18004 §7.8.3). Follows the structure of Project Nayuki's
// QR Code generator (MIT), written again here. Pure; checked module for module against Python's qrcode
// (mod/tests/test_qrcode.mjs).

const ECL = { L: 0, M: 1, Q: 2, H: 3 }
const FORMAT_ECL = [1, 0, 3, 2]      // the format bits' code of L, M, Q, H
// per level, per version (index 0 unused): error correction codewords per block and the number of blocks
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
]
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
]
export const MAX_VERSION = 10

function rawDataModules(ver) {
  let n = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2
    n -= (25 * align - 10) * align - 55
    if (ver >= 7) n -= 36
  }
  return n
}
function dataCodewords(ver, ecl) {
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * BLOCKS[ecl][ver]
}
function alignmentPositions(ver, size) {
  if (ver === 1) return []
  const n = Math.floor(ver / 7) + 2
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2
  const out = [6]
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos)
  return out
}

// GF(256) with the QR code's polynomial x^8 + x^4 + x^3 + x^2 + 1
function gfMul(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}
function rsDivisor(degree) {
  const out = new Array(degree).fill(0)
  out[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      out[j] = gfMul(out[j], root)
      if (j + 1 < degree) out[j] ^= out[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return out
}
function rsRemainder(data, divisor) {
  const out = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ out.shift()
    out.push(0)
    divisor.forEach((d, i) => { out[i] ^= gfMul(d, factor) })
  }
  return out
}

function utf8(text) {
  if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(text))
  return Array.from(unescape(encodeURIComponent(text)), c => c.charCodeAt(0))
}

// The data codewords of bytes at (ver, ecl): mode, count, data, terminator, padding.
function dataBits(bytes, ver, ecl) {
  const bits = []
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1) }
  put(4, 4)                                   // byte mode
  put(bytes.length, ver <= 9 ? 8 : 16)
  for (const b of bytes) put(b, 8)
  const cap = dataCodewords(ver, ecl) * 8
  put(0, Math.min(4, cap - bits.length))
  put(0, (8 - bits.length % 8) % 8)
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8)
  const out = []
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))
  return out
}

function interleave(data, ver, ecl) {
  const nBlocks = BLOCKS[ecl][ver], eccLen = ECC_PER_BLOCK[ecl][ver]
  const raw = Math.floor(rawDataModules(ver) / 8)
  const nShort = nBlocks - raw % nBlocks, shortLen = Math.floor(raw / nBlocks)
  const div = rsDivisor(eccLen)
  const blocks = []
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, div)
    if (i < nShort) dat.push(0)
    blocks.push(dat.concat(ecc))
  }
  const out = []
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) out.push(b[i]) })
  }
  return out
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5: return (x * y) % 2 + (x * y) % 3 === 0
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0
    default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0
  }
}

// The matrix of one version, level and mask: modules[y][x], true = dark.
function build(codewords, ver, ecl, mask) {
  const size = ver * 4 + 17
  const mod = Array.from({ length: size }, () => new Array(size).fill(false))
  const fn = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true }
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0) }        // timing
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {                       // finders + separators
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy))
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4)
    }
  }
  const al = alignmentPositions(ver, size), last = al.length - 1
  al.forEach((ax, i) => al.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }))
  const format = () => {
    const data = (FORMAT_ECL[ecl] << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    const bit = i => ((bits >>> i) & 1) !== 0
    for (let i = 0; i <= 5; i++) set(8, i, bit(i))
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
    set(8, size - 8, true)
  }
  format()
  if (ver >= 7) {
    let rem = ver
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (ver << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0, a = size - 11 + i % 3, b = Math.floor(i / 3)
      set(a, b, dark); set(b, a, dark)
    }
  }
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {                                   // the zigzag
    if (right === 6) right = 5
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - v : v
      if (!fn[y][x] && i < codewords.length * 8) { mod[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++ }
    }
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && maskBit(mask, x, y)) mod[y][x] = !mod[y][x]
  return mod
}

// ISO/IEC 18004 §7.8.3: runs of 5+, 2x2 blocks, finder-like 1:1:3:1:1 with 4 light, dark share.
function penalty(mod) {
  const size = mod.length
  let p = 0, dark = 0
  const line = get => {
    let run = 1
    for (let i = 1; i <= size; i++) {
      if (i < size && get(i) === get(i - 1)) { run++; continue }
      if (run >= 5) p += run - 2
      run = 1
    }
    for (let i = 0; i + 11 <= size; i++) {
      const s = Array.from({ length: 11 }, (_, k) => get(i + k) ? 1 : 0).join("")
      if (s === "10111010000" || s === "00001011101") p += 40
    }
  }
  for (let k = 0; k < size; k++) { line(i => mod[k][i]); line(i => mod[i][k]) }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (mod[y][x]) dark++
    if (x + 1 < size && y + 1 < size) {
      const c = mod[y][x]
      if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3
    }
  }
  const total = size * size
  p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
  return p
}

// text -> { version, size, mask, modules } (modules[y][x], true = dark), or null when it does not fit version 10.
// ecl "L" / "M" / "Q" / "H"; mask 0-7, or -1: the one with the least penalty.
export function encode(text, ecl = "M", mask = -1) {
  const e = ECL[ecl] ?? ECL.M
  const bytes = utf8(String(text))
  let ver = 1
  while (ver <= MAX_VERSION && 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver, e) * 8) ver++
  if (ver > MAX_VERSION) return null
  const cw = interleave(dataBits(bytes, ver, e), ver, e)
  let best = null
  for (let m = 0; m < 8; m++) {
    if (mask >= 0 && m !== mask) continue
    const mod = build(cw, ver, e, m)
    const score = mask >= 0 ? 0 : penalty(mod)
    if (!best || score < best.score) best = { score, mask: m, modules: mod }
  }
  return { version: ver, size: ver * 4 + 17, mask: best.mask, modules: best.modules }
}

// An SVG path of the dark modules, one unit each, offset by border (the quiet zone: 4 by the standard).
export function svgPath(qr, border = 4) {
  let d = ""
  qr.modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + border} ${y + border}h1v1h-1z` }))
  return d
}
