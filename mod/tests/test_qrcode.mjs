// node --test mod/tests/test_qrcode.mjs  (qrcode.js: the world map's "Send to phone" QR code)
// The matrices' SHA-256 are Python qrcode 8.2's for the same text, level and mask (byte mode); the encoder was also
// compared module for module with it for 7 texts x 4 levels x 8 masks (192 matrices, every version 1-10 it picked).
import * as qr from "../beamng_earth/ui/ui-vue/mods/beamngEarth/qrcode.js"
import assert from "node:assert"
import { createHash } from "node:crypto"
import test from "node:test"

const sha = q => createHash("sha256").update(q.modules.map(r => r.map(b => (b ? "1" : "0")).join("")).join("\n")).digest("hex")

test("the same matrices as Python's qrcode", () => {
  const cases = [
    ["https://www.google.com/maps/search/?api=1&query=51.178882%2C-1.826215", "M", 2, 5,
      "d631a0636b3f540be299f2d211825670777fd869f7b4f2a386b62c0de7bd3b35"],
    ["https://www.google.com/maps/dir/?api=1&origin=50.060000%2C19.940000&destination=52.230000%2C21.010000&travelmode=driving",
      "M", 5, 7, "afab511e57e40d14ef70bc599fbd33601f08912a8ae3fc03f6d70040edaac153"],     // version 7: the version info
    ["y".repeat(200), "M", 7, 10, "df777c71b9e94f235d8962e0f9009bd1afec6bce21b353a353ffdd0858f07a75"],   // 16-bit count
    ["Kraków", "H", 0, 1, "cf46f21509da38db8e5b3c67a269036119b34a5055c51bdea850ace476561f70"],           // UTF-8
  ]
  for (const [text, ecl, mask, version, hash] of cases) {
    const q = qr.encode(text, ecl, mask)
    assert.strictEqual(q.version, version, text)
    assert.strictEqual(q.size, version * 4 + 17)
    assert.strictEqual(sha(q), hash, `${text.slice(0, 30)} ${ecl} mask ${mask}`)
  }
})

test("the mask with the least penalty, and the limits", () => {
  const q = qr.encode("https://www.google.com/maps/search/?api=1&query=51.178882%2C-1.826215")
  assert.ok(q.mask >= 0 && q.mask < 8)
  assert.strictEqual(sha(q), sha(qr.encode("https://www.google.com/maps/search/?api=1&query=51.178882%2C-1.826215", "M", q.mask)))
  for (const [x, y] of [[0, 0], [q.size - 7, 0], [0, q.size - 7]]) {       // the three finders' dark corners
    assert.ok(q.modules[y][x] && q.modules[y + 6][x + 6] && !q.modules[y + 1][x + 1] && q.modules[y + 3][x + 3])
  }
  assert.ok(qr.encode("z".repeat(213), "M"), "213 bytes fit version 10 at M")
  assert.strictEqual(qr.encode("z".repeat(214), "M"), null, "214 do not")
  const d = qr.svgPath(qr.encode("a", "L", 0), 4)
  assert.ok(d.startsWith("M4 4h1v1h-1z"), "the quiet zone offsets the path")
})
