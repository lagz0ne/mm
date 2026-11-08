// What a committed artifact may not hold (sy-wxzx): the shapes of keys and tokens. config-check --staged runs it on
// every staged file under artifacts/ (the pre-commit hook), and bin/artifact before it copies anything. It reads the
// bytes as text (images too: their text chunks), and it never prints what it found, only its kind.
//   node bin/lib/secret-scan.mjs <file>...   exit 1 with "<file>: looks like <kind>" for each hit
// A screenshot of a secret is pixels: no scan sees it. The brief says what not to capture.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SHAPES = [
  ['a private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/],
  ['an age secret key', /AGE-SECRET-KEY-1[0-9A-Z]{50,}/],
  ['an Anthropic key or token', /sk-ant-[a-z0-9]{2,8}-[A-Za-z0-9_-]{20,}/],
  ['an API key (sk-...)', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['a GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a Telegram bot token', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ['a JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['a password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]{6,}@/],
]

/** The kinds of secret the bytes look like ([] when none). */
export function secretsIn(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf)
  return SHAPES.filter(([, re]) => re.test(text)).map(([kind]) => kind)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let hits = 0
  for (const f of process.argv.slice(2)) {
    let kinds
    try { kinds = secretsIn(fs.readFileSync(f)) } catch (e) { console.error(`${f}: cannot read (${e.code || e.message})`); hits++; continue }
    for (const k of kinds) { console.error(`${f}: looks like ${k}`); hits++ }
  }
  process.exit(hits ? 1 : 0)
}
