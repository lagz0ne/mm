// After `vite build`: write .br and .gz next to every text asset, so the server can send them pre-compressed.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
const dir = path.join(import.meta.dirname, 'dist')
let n = 0, saved = 0
for (const f of fs.readdirSync(dir, { recursive: true })) {
  const p = path.join(dir, String(f))
  if (!/\.(js|css|html|svg|json)$/.test(p) || !fs.statSync(p).isFile()) continue
  const raw = fs.readFileSync(p)
  const br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } })
  fs.writeFileSync(p + '.br', br); fs.writeFileSync(p + '.gz', zlib.gzipSync(raw, { level: 9 }))
  n++; saved += raw.length - br.length
}
console.log(`compressed ${n} files (brotli saves ${(saved / 1024).toFixed(0)} KB)`)
