// mm publish: push mm's own main to its public remote, a fast-forward only, and only when the scans pass.
// Everything it trusts comes from the machine config (config.yaml `publish:`), never from the repo (a commit, or anyone
// who can write the repo's .git/config, must not choose where it goes or what counts as private):
//   publish.repo           the repo to publish (a path; ~/ allowed)
//   publish.remote         the public remote's URL (the repo's own origin, written down here)
//   publish.private_words  the words that must never go out: a map name -> word (the name is what a refusal prints),
//                          or a list (printed as #1, #2, ...). Unset or empty: every publish is refused.
//   publish.auto           true: mm cron runs `mm publish --auto` every 5 minutes (off by default)
// The range origin/main..main, commit by commit: every added line (binary files as bytes), every path, every message,
// author and committer, against the secret shapes (template/bin/lib/secret-scan.mjs) and the private words (any case).
// A refusal prints the pattern's name and where (commit, file:line), never the text it matched. Then
// `git push <remote> <sha>:refs/heads/main`: no force, no hooks, no URL rewrite. A refusal opens nothing by itself.
// --auto (what cron runs): nothing while publish.auto is off; a refusal stays refused until main moves to another commit.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPath, loadConfig, type Config } from './config'
import { DIRS, HOME, run } from './env'
import { SHAPES } from '../template/bin/lib/secret-scan.mjs'

const STATE = join(DIRS.data, 'publish.json')
const EVERY_MS = 5 * 60e3
export { EVERY_MS as PUBLISH_EVERY_MS }

export type Hit = { where: string; kind: string }
export type Result =
  | { status: 'pushed'; sha: string; from: string; commits: number }
  | { status: 'current'; sha: string }
  | { status: 'off' | 'held'; sha?: string; reason?: string }
  | { status: 'refused'; sha?: string; reason: string; hits?: Hit[]; sticky: boolean }

type Words = { name: string; word: string }[]
export type Settings = { repo: string; remote: string; words: Words }

/** The settings, or why they are not usable. */
export function settings(c: Config = loadConfig()): Settings | string {
  const repo = String(getPath(c, 'publish.repo') ?? '').trim().replace(/^~(?=\/)/, HOME)
  const remote = String(getPath(c, 'publish.remote') ?? '').trim()
  if (!repo.startsWith('/')) return 'publish.repo is not set (an absolute path)'
  if (!remote) return 'publish.remote is not set'
  const raw = getPath(c, 'publish.private_words')
  const words: Words = Array.isArray(raw) ? raw.map((w, i) => ({ name: `#${i + 1}`, word: String(w ?? '').trim() }))
    : raw && typeof raw === 'object' ? Object.entries(raw as Record<string, unknown>).map(([name, w]) => ({ name, word: String(w ?? '').trim() })) : []
  if (!words.length || words.some((w) => !w.word)) return 'publish.private_words is not set (or has an empty word): nothing would stop a private name'
  return { repo, remote, words }
}

/** git in the repo: no hooks (core.hooksPath), no fsmonitor, no prompts, paths as bytes. */
const git = (repo: string, args: string[], timeoutMs = 60_000) =>
  run(['git', '-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', ...args],
    { timeoutMs, env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' } })
/** The push, exactly: an explicit commit to an explicit ref, never --force and never a + refspec. */
export const pushArgs = (remote: string, sha: string) => ['push', '--no-verify', '--no-follow-tags', '--porcelain', remote, `${sha}:refs/heads/main`]
const redact = (s: string) => s.replace(/(:\/\/)[^\s/@]+@/g, '$1***@')
const lastLine = (s: string) => redact(s.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '').slice(0, 300)

/** What in `text` is private or a secret: the names only. */
export function hitsIn(text: string, words: Words): string[] {
  const lower = text.toLowerCase(), out: string[] = []
  for (const w of words) if (lower.includes(w.word.toLowerCase())) out.push(`private word ${w.name}`)
  for (const [kind, re] of SHAPES as [string, RegExp][]) if (re.test(text)) out.push(kind)
  return out
}

/** Scan the commits of `from..sha`: each one's message, author, committer, and its diff against its first parent. */
export function scan(s: Settings, from: string, sha: string): { hits: Hit[]; commits: number } | string {
  const rl = git(s.repo, ['rev-list', '--reverse', '--parents', `${from}..${sha}`])
  if (!rl.ok) return `git rev-list failed: ${lastLine(rl.err)}`
  const hits: Hit[] = []
  const add = (where: string, kinds: string[]) => { for (const kind of kinds) hits.push({ where, kind }) }
  const lines = rl.out.split('\n').filter(Boolean)
  for (const l of lines) {
    const [c, p1] = l.split(' '), id = c.slice(0, 10)
    const obj = git(s.repo, ['cat-file', 'commit', c])
    if (!obj.ok) return `git cat-file failed for ${id}`
    const cut = obj.out.indexOf('\n\n'), head = cut < 0 ? obj.out : obj.out.slice(0, cut), msg = cut < 0 ? '' : obj.out.slice(cut + 2)
    for (const h of head.split('\n')) {
      const m = /^(author|committer) (.*)$/.exec(h)
      if (m) add(`${id} ${m[1]}`, hitsIn(m[2], s.words))
    }
    add(`${id} message`, hitsIn(msg, s.words))
    const d = git(s.repo, ['diff-tree', '-r', '-p', '-a', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--src-prefix=a/', '--dst-prefix=b/', ...(p1 ? [p1, c] : ['--root', c])], 120_000)
    if (!d.ok) return `git diff-tree failed for ${id}`
    let file = '', shown = '', n = 0, inHunk = false
    for (const t of d.out.split('\n')) {
      if (t.startsWith('diff --git ')) { inHunk = false; continue }
      if (!inHunk) {
        if (t.startsWith('+++ ')) {
          file = t === '+++ /dev/null' ? '' : t.slice(4).replace(/^b\//, '')
          const k = file ? hitsIn(file, s.words) : []
          shown = k.length ? '(a path with a hit)' : file
          add(`${id} ${shown} (its path)`, k)
        } else if (t.startsWith('@@ ')) { inHunk = true; n = Number(/\+(\d+)/.exec(t)?.[1] ?? 0) }
        continue
      }
      if (t.startsWith('@@ ')) { n = Number(/\+(\d+)/.exec(t)?.[1] ?? 0); continue }
      if (t.startsWith('+')) { add(`${id} ${shown}:${n}`, hitsIn(t.slice(1), s.words)); n++ }
    }
  }
  return { hits, commits: lines.length }
}

/** One publish: resolve main, fetch, fast-forward check, scan, push. */
export function publish(s: Settings): Result {
  const r = git(s.repo, ['rev-parse', '--verify', '-q', 'refs/heads/main^{commit}'])
  if (!r.ok) return { status: 'refused', reason: `${s.repo}: no main branch`, sticky: false }
  const sha = r.out.trim()
  // the remote's URL as git would really use it: no url.<x>.insteadOf / pushInsteadOf rule may rewrite it
  const rw = git(s.repo, ['config', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$'])
  for (const l of rw.out.split('\n').filter(Boolean)) {
    const v = l.slice(l.indexOf(' ') + 1)
    if (v && s.remote.startsWith(v)) return { status: 'refused', sha, reason: 'a url.*.insteadOf rule in git config would rewrite publish.remote', sticky: false }
  }
  const f = git(s.repo, ['fetch', '-q', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', s.remote, '+refs/heads/main:refs/remotes/origin/main'])
  if (!f.ok) return { status: 'refused', sha, reason: `fetch failed: ${lastLine(f.err)}`, sticky: false }
  const from = git(s.repo, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/main^{commit}']).out.trim()
  if (!from) return { status: 'refused', sha, reason: 'the remote has no main (the first push is not this command\'s)', sticky: false }
  if (from === sha) return { status: 'current', sha }
  if (!git(s.repo, ['merge-base', '--is-ancestor', from, sha]).ok)
    return { status: 'refused', sha, reason: `not a fast-forward: the remote's main ${from.slice(0, 10)} is not in main ${sha.slice(0, 10)}`, sticky: true }
  const sc = scan(s, from, sha)
  if (typeof sc === 'string') return { status: 'refused', sha, reason: sc, sticky: false }
  if (sc.hits.length) return { status: 'refused', sha, reason: `${sc.hits.length} scan hit(s) in ${from.slice(0, 10)}..${sha.slice(0, 10)}`, hits: sc.hits, sticky: true }
  const p = git(s.repo, pushArgs(s.remote, sha), 120_000)
  if (!p.ok) return { status: 'refused', sha, reason: `push failed: ${lastLine(p.err || p.out)}`, sticky: false }
  git(s.repo, ['update-ref', 'refs/remotes/origin/main', sha, from])
  return { status: 'pushed', sha, from, commits: sc.commits }
}

/** The lines a result prints (stdout for a push, stderr for a refusal). */
export function describe(r: Result): string[] {
  switch (r.status) {
    case 'pushed': return [`published main ${r.from.slice(0, 10)}..${r.sha.slice(0, 10)} (${r.commits} commit(s))`]
    case 'current': return [`up to date: the remote's main is ${r.sha.slice(0, 10)}`]
    case 'off': return ['publish.auto is off: nothing to do']
    case 'held': return [`held: main ${r.sha?.slice(0, 10)} was refused (${r.reason}); it waits for main to move (or run mm publish by hand)`]
    case 'refused': return [`refused: ${r.reason}`, ...(r.hits ?? []).slice(0, 50).map((h) => `  ${h.where}: ${h.kind}`),
      ...((r.hits?.length ?? 0) > 50 ? [`  ... and ${r.hits!.length - 50} more`] : [])]
  }
}

type State = { sha?: string; reason?: string; sticky?: boolean }
const readState = (): State => { try { return JSON.parse(readFileSync(STATE, 'utf8')) } catch { return {} } }
function writeState(st: State) { try { mkdirSync(DIRS.data, { recursive: true }); writeFileSync(STATE, JSON.stringify(st) + '\n') } catch {} }

/** `mm publish` (auto = what cron runs). Returns the result and whether it is worth a log line (a new outcome). */
export function runPublish(auto: boolean, c: Config = loadConfig()): { result: Result; news: boolean } {
  if (auto && getPath(c, 'publish.auto') !== true) return { result: { status: 'off' }, news: false }
  const s = settings(c)
  const st = readState()
  if (typeof s === 'string') {
    const news = st.reason !== s
    writeState({ reason: s })
    return { result: { status: 'refused', reason: s, sticky: false }, news }
  }
  if (auto && st.sticky && st.sha) {
    const now = git(s.repo, ['rev-parse', '--verify', '-q', 'refs/heads/main^{commit}']).out.trim()
    if (now === st.sha) return { result: { status: 'held', sha: st.sha, reason: st.reason }, news: false }
  }
  const result = publish(s)
  if (result.status === 'refused') {
    const news = st.sha !== result.sha || st.reason !== result.reason
    writeState({ sha: result.sha, reason: result.reason, sticky: result.sticky })
    return { result, news }
  }
  if (existsSync(STATE) && (st.sha || st.reason)) writeState({})
  return { result, news: result.status === 'pushed' }
}

/** Cron's hook (every PUBLISH_EVERY_MS): one obs line when something new happened, else null. */
export function cronPublish(): { level: 'info' | 'error'; msg: string } | null {
  const { result, news } = runPublish(true)
  if (!news) return null
  const l = describe(result)
  return { level: result.status === 'refused' ? 'error' : 'info', msg: `publish ${l[0]}${l.length > 1 ? `: ${l.slice(1, 6).map((x) => x.trim()).join('; ')}` : ''}` }
}
