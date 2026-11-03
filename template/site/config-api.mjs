// Config API for the Leads page. The board never writes config itself: edits, skill installs and restarts become
// governance requests (Beads items assigned to the `setup` agent, label `governance`). The setup agent applies them
// and commits. Read-only here: history, diffs, Claude review suggestions, skills.sh search/preview.
import { execFile, fetch } from '../bin/lib/obs.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function configApi({ ROOT, ROLES, PROJECT, PASEO, BD, send, readBody, who }) {
  const sh = (cmd, args, opts = {}) => new Promise((ok, no) =>
    execFile(cmd, args, { cwd: ROOT, maxBuffer: 16 << 20, timeout: opts.timeout || 30000, env: { ...process.env, ...opts.env } },
      (e, out, err) => (e ? no(new Error(String(err || e.message).trim().slice(0, 600))) : ok(out))))
  const git = (args, opts) => sh('git', args, opts)
  const ROLE_RE = `(${ROLES.join('|')})`
  const NAME = '[a-z0-9][a-z0-9._-]{0,63}'
  // What the board may edit (relative to the project root).
  const EDITABLE = [
    /^CLAUDE\.md$/, /^leads\/CLAUDE\.md$/, /^leads\/START\.md$/, /^worktrees\/CLAUDE\.md$/,
    new RegExp(`^leads/${ROLE_RE}/CLAUDE\\.md$`),
    new RegExp(`^leads/${ROLE_RE}/\\.claude/settings\\.tmpl\\.json$`),
    new RegExp(`^leads/${ROLE_RE}/\\.claude/skills/${NAME}/[a-zA-Z0-9._/-]{1,120}\\.(md|txt|ya?ml|json)$`),
  ]
  const editable = (p) => typeof p === 'string' && !p.includes('..') && EDITABLE.some((re) => re.test(p))

  async function body(req) { try { return JSON.parse((await readBody(req)) || '{}') } catch { return null } }

  // ---- history and diffs of config files
  async function history(req, res, url) {
    const p = url.searchParams.get('path') || ''
    if (!editable(p) && !/^leads\/[a-z]+\/\.claude\/skills\/[^/]+$/.test(p)) return send(res, 400, { title: 'bad path' })
    const out = await git(['log', '-n', '30', '--format=%h%x1f%an%x1f%cI%x1f%s', '--', p]).catch(() => '')
    send(res, 200, { path: p, commits: out.trim().split('\n').filter(Boolean).map((l) => { const [sha, author, date, subject] = l.split('\x1f'); return { sha, author, date, subject } }) })
  }
  async function diff(req, res, url) {
    const p = url.searchParams.get('path') || ''; const rev = url.searchParams.get('rev') || ''
    if (!/^[0-9a-f]{4,40}$/.test(rev) || (!editable(p) && !/^leads\/[a-z]+\/\.claude\/skills\/[^/]+$/.test(p))) return send(res, 400, { title: 'bad request' })
    const out = await git(['show', '--format=%h %an %s', rev, '--', p]).catch((e) => e.message)
    send(res, 200, { diff: out })
  }

  // ---- review a prompt with Claude (a short Paseo run with structured output)
  const jobs = new Map()
  const SCHEMA = JSON.stringify({ type: 'object', required: ['summary', 'revised', 'changes'], properties: {
    summary: { type: 'string', description: 'Two or three sentences: what you changed and why.' },
    changes: { type: 'array', items: { type: 'string' }, description: 'Each change, one line each.' },
    revised: { type: 'string', description: 'The complete revised file content.' } } })
  async function startReview(req, res) {
    const b = await body(req)
    if (!b || !editable(b.path)) return send(res, 400, { title: 'not an editable file' })
    const text = typeof b.content === 'string' ? b.content : fs.readFileSync(path.join(ROOT, b.path), 'utf8')
    const role = (/^leads\/([a-z]+)\//.exec(b.path) || [])[1]
    const layers = ['CLAUDE.md', 'leads/CLAUDE.md', role && ROLES.includes(role) ? `leads/${role}/CLAUDE.md` : null]
      .filter((p) => p && p !== b.path).map((p) => { try { return `--- ${p} ---\n${fs.readFileSync(path.join(ROOT, p), 'utf8')}` } catch { return '' } }).join('\n\n')
    const prompt = [
      `You are reviewing one instruction file used by AI agents ("leads") in the ${PROJECT} project. File: ${b.path}.`,
      'Goal: prune it. Remove repetition (including anything already said in the other layers below, which the same agent also loads),',
      'vague or generic advice, and wording that does not change behaviour. Tighten sentences. Keep every concrete rule, path, command,',
      'limit and safety constraint (permissions, never-do lists, approval steps). Do not invent new rules. Keep the markdown structure.',
      b.focus ? `Extra focus from the human: ${String(b.focus).slice(0, 500)}` : '',
      'Return the complete revised file in `revised`, a short `summary`, and one line per change in `changes`. Do not use tools.',
      '', `=== FILE ${b.path} ===`, text, '', '=== OTHER LAYERS (context only, do not return them) ===', layers || '(none)',
    ].join('\n')
    const id = crypto.randomBytes(6).toString('hex')
    jobs.set(id, { status: 'running', path: b.path, started: Date.now() })
    sh(PASEO, ['run', '--provider', 'claude/claude-opus-5-5', '--mode', 'plan', '--cwd', ROOT, '--title', `${PROJECT} · prompt review`,
      '--label', `project=${PROJECT}-tool`, '--label', `job=${id}`, '--wait-timeout', '6m', '--output-schema', SCHEMA, prompt], { timeout: 420000 })
      .then((out) => {
        const j = out.slice(out.indexOf('{'))
        jobs.set(id, { ...jobs.get(id), status: 'done', result: JSON.parse(j) })
      })
      .catch((e) => jobs.set(id, { ...jobs.get(id), status: 'error', error: e.message }))
      .finally(async () => {
        try { for (const a of (await sh(PASEO, ['ls', '-g', '-a', '--label', `job=${id}`, '-q'])).split(/\s+/).filter(Boolean)) await sh(PASEO, ['delete', a]) } catch {}
      })
    send(res, 202, { job: id })
  }
  function reviewStatus(res, id) {
    const j = jobs.get(id)
    if (!j) return send(res, 404, { title: 'no such job' })
    send(res, 200, { ...j, elapsed: Math.round((Date.now() - j.started) / 1000) })
  }

  // ---- skills.sh: search, preview, install, remove
  const SKILLS = 'https://skills.sh'
  const SKILL_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/
  async function skillSearch(res, url) {
    const q = (url.searchParams.get('q') || '').trim()
    if (q.length < 2) return send(res, 200, { skills: [] })
    const r = await fetch(`${SKILLS}/api/search?${new URLSearchParams({ q, limit: '30' })}`, { signal: AbortSignal.timeout(15000) })
    if (!r.ok) return send(res, 502, { title: `skills.sh search failed (${r.status})` })
    const d = await r.json()
    send(res, 200, { skills: (d.skills || []).map((s) => ({ id: s.id, name: s.name, source: s.source, installs: s.installs })) })
  }
  async function download(id) {
    if (!SKILL_ID.test(id)) throw new Error('bad skill id')
    const [owner, repo, slug] = id.split('/')
    const r = await fetch(`${SKILLS}/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(30000) })
    if (!r.ok) throw new Error(`skills.sh download failed (${r.status})`)
    const d = await r.json()
    const files = (d.files || []).filter((f) => typeof f.path === 'string' && typeof f.contents === 'string')
    if (!files.some((f) => f.path.toLowerCase() === 'skill.md')) throw new Error('no SKILL.md in this skill')
    for (const f of files) if (f.path.includes('..') || path.isAbsolute(f.path) || !/^[\w./ -]{1,200}$/.test(f.path)) throw new Error(`unsafe path in skill: ${f.path}`)
    const total = files.reduce((n, f) => n + f.contents.length, 0)
    if (files.length > 60 || total > 2_000_000) throw new Error('skill too large')
    return { slug, files, hash: d.hash || null }
  }
  async function skillPreview(res, url) {
    try {
      const { slug, files, hash } = await download(url.searchParams.get('id') || '')
      send(res, 200, { slug, hash, files: files.map((f) => ({ path: f.path, size: f.contents.length,
        script: /\.(sh|py|js|mjs|ts|rb|pl|ps1|bash)$/.test(f.path), contents: /\.(md|txt)$/i.test(f.path) ? f.contents.slice(0, 40000) : undefined })) })
    } catch (e) { send(res, 502, { title: e.message }) }
  }

  // ---- governance requests to the setup agent
  const fence = (text) => { const n = Math.max(3, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length + 1)); return '`'.repeat(n) }
  async function request(req, res) {
    const b = await body(req)
    if (!b) return send(res, 400, { title: 'bad JSON' })
    const note = String(b.note || '').slice(0, 4000).trim()
    let title, desc
    if (b.kind === 'edit') {
      if (!editable(b.path) || typeof b.content !== 'string' || b.content.length > 150_000) return send(res, 400, { title: 'not an editable file' })
      const f = fence(b.content)
      title = `Edit ${b.path}`
      desc = `${note ? `${note}\n\n` : ''}Replace \`${b.path}\` with this content:\n\n${f}${b.path.endsWith('.json') ? 'json' : 'markdown'}\n${b.content}\n${f}`
    } else if (b.kind === 'skill-install') {
      if (!ROLES.includes(b.role) || !SKILL_ID.test(b.skill || '')) return send(res, 400, { title: 'bad role or skill id' })
      title = `Install skill ${b.skill} for ${b.role}`
      desc = `${note ? `${note}\n\n` : ''}Install skills.sh skill \`${b.skill}\` for the **${b.role}** lead (review its files first).`
    } else if (b.kind === 'skill-remove') {
      if (!ROLES.includes(b.role) || !new RegExp(`^${NAME}$`).test(b.name || '')) return send(res, 400, { title: 'bad request' })
      title = `Remove skill ${b.name} from ${b.role}`
      desc = note || `Remove skill \`${b.name}\` from the ${b.role} lead.`
    } else if (b.kind === 'restart') {
      if (!ROLES.includes(b.role)) return send(res, 400, { title: 'bad role' })
      title = `Restart the ${b.role} lead`
      desc = note || `Restart the ${b.role} lead so it loads the current brief, skills and permissions.`
    } else if (b.kind === 'ask') {
      if (!note) return send(res, 400, { title: 'say what you need' })
      title = note.split('\n')[0].slice(0, 100); desc = note
    } else return send(res, 400, { title: 'unknown request kind' })
    const actor = who(req)
    const r = await fetch(new URL('/v0/beads/issues', BD), { method: 'POST', headers: { 'content-type': 'application/json', host: BD.host },
      body: JSON.stringify({ title, description: desc, issue_type: 'task', priority: 2, assignee: 'setup', labels: ['governance'], actor, owner: actor }) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) return send(res, 502, { title: d.detail || d.title || 'could not create the request' })
    send(res, 200, { id: d.id, title })
  }

  // Router: returns true when it handled the request.
  return async function handle(req, res, url) {
    const p = url.pathname, m = req.method
    try {
      if (p === '/api/config/request' && m === 'POST') return await request(req, res), true
      if (p === '/api/config/history' && m === 'GET') return await history(req, res, url), true
      if (p === '/api/config/diff' && m === 'GET') return await diff(req, res, url), true
      if (p === '/api/config/review' && m === 'POST') return await startReview(req, res), true
      const rj = /^\/api\/config\/review\/([0-9a-f]{12})$/.exec(p)
      if (rj && m === 'GET') return reviewStatus(res, rj[1]), true
      if (p === '/api/skills/search' && m === 'GET') return await skillSearch(res, url), true
      if (p === '/api/skills/preview' && m === 'GET') return await skillPreview(res, url), true
    } catch (e) { send(res, 500, { title: e.message }); return true }
    return false
  }
}
