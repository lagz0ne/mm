#!/usr/bin/env node
// A stand-in for Dolt's MySQL socket, for test/pc-skipped.sh: node fake-mysql.mjs <socket> <mode>
//   ok      greeting, login OK, SELECT 1 -> a result set
//   switch  as ok, but the login first asks to switch the auth method (answered with an empty password)
//   deny    login refused (ERR 1045)
//   silent  accepts the connection and never says anything (a Dolt still loading)
// Each connection's client packets go to <socket>.log (one hex line each), so the test can check what was sent.
import fs from 'node:fs'
import net from 'node:net'

const [sock, mode = 'ok'] = process.argv.slice(2)
fs.rmSync(sock, { force: true })
const pkt = (seq, body) => { const h = Buffer.alloc(4); h.writeUIntLE(body.length, 0, 3); h[3] = seq; return Buffer.concat([h, body]) }
const greeting = () => {
  const salt = Buffer.alloc(20, 0x41)
  return Buffer.concat([Buffer.from([10]), Buffer.from('8.0.33\0'), Buffer.from([1, 0, 0, 0]), salt.subarray(0, 8), Buffer.from([0]),
    Buffer.from([0xff, 0xf7]), Buffer.from([33]), Buffer.from([2, 0]), Buffer.from([0xff, 0x81]), Buffer.from([21]), Buffer.alloc(10),
    salt.subarray(8), Buffer.from([0]), Buffer.from('mysql_native_password\0')])
}
const OK = Buffer.from([0, 0, 0, 2, 0, 0, 0])
net.createServer((c) => {
  if (mode === 'silent') return
  c.write(pkt(0, greeting()))
  let buf = Buffer.alloc(0), n = 0
  c.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 4 && buf.length >= 4 + buf.readUIntLE(0, 3)) {
      const len = buf.readUIntLE(0, 3), seq = buf[3], p = buf.subarray(4, 4 + len)
      buf = buf.subarray(4 + len); n++
      fs.appendFileSync(`${sock}.log`, `${seq} ${p.toString('hex')}\n`)
      if (n === 1) { // the login
        if (mode === 'deny') c.write(pkt(seq + 1, Buffer.concat([Buffer.from([0xff, 0x15, 0x04]), Buffer.from('#28000Access denied')])))
        else if (mode === 'switch') c.write(pkt(seq + 1, Buffer.concat([Buffer.from([0xfe]), Buffer.from('mysql_native_password\0'), Buffer.alloc(20, 0x42), Buffer.from([0])])))
        else c.write(pkt(seq + 1, OK))
      } else if (n === 2 && mode === 'switch') c.write(pkt(seq + 1, OK)) // the empty answer to the switch
      else if (p[0] === 0x03) c.write(Buffer.concat([pkt(1, Buffer.from([1])), pkt(2, Buffer.from('03646566000000013100', 'hex')), pkt(3, Buffer.from([1, 0x31])), pkt(4, Buffer.from([0xfe, 0, 0, 2, 0]))]))
      else if (p[0] === 0x01) c.end() // COM_QUIT
    }
  })
  c.on('error', () => {})
}).listen(sock)
