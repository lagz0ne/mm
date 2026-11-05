// Spike (sy-nwp, plan: accounts on Better Auth): prove the pieces mm.auth needs, hermetic, on Bun's SQLite.
//   bun test/ba-spike.ts        exit 0 = every step worked
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { admin, bearer, magicLink, organization } from 'better-auth/plugins'
import { createAccessControl } from 'better-auth/plugins/access'

const dir = mkdtempSync(join(tmpdir(), 'ba-spike-'))
let pass = 0, fail = 0
const ok = (d: string, c: unknown) => { c ? pass++ : fail++; console.log(`  ${c ? 'ok  ' : 'FAIL'} ${d}`) }
const ac = createAccessControl({ board: ['read', 'comment', 'steer'], doop: ['read', 'edit'] } as const)
const roles = {
  owner: ac.newRole({ board: ['read', 'comment', 'steer'], doop: ['read', 'edit'] }),
  designer: ac.newRole({ board: ['read', 'comment', 'steer'], doop: ['read', 'edit'] }),
  member: ac.newRole({ board: ['read', 'comment', 'steer'], doop: ['read'] }),
  viewer: ac.newRole({ board: ['read'], doop: ['read'] }),
}
let lastLink = ''
const auth = betterAuth({
  baseURL: 'https://auth.example.test', secret: 'spike-secret-0123456789abcdef0123456789', telemetry: { enabled: false },
  database: new Database(join(dir, 'auth.db')),
  emailAndPassword: { enabled: false },
  plugins: [
    admin(),
    organization({ ac, roles, allowUserToCreateOrganization: false }),
    magicLink({ sendMagicLink: async ({ url }) => { lastLink = url }, expiresIn: 600 }), // mm prints the link; no mail
    bearer(),
  ],
})
try {
  const { runMigrations } = await getMigrations(auth.options); await runMigrations()
  ok('schema migrated on bun:sqlite', true)
  const ctx = await auth.$context
  const alex = await ctx.internalAdapter.createUser({ email: 'alex@users.mm.invalid', name: 'alex', emailVerified: true })
  ok('a user with no password (server side)', alex?.id)
  await auth.api.signInMagicLink({ body: { email: 'alex@users.mm.invalid', callbackURL: '/' }, headers: new Headers() })
  ok('a magic link, captured by mm (not mailed)', /\/magic-link\/verify\?token=/.test(lastLink))
  const r = await auth.handler(new Request(lastLink, { redirect: 'manual' }))
  const sc = r.headers.getSetCookie?.() || [], cookie = sc.find((c) => /^(__Secure-)?better-auth\.session_token=/.test(c)) || ''
  if (!cookie) console.log('     status', r.status, r.headers.get('location'), sc.map((c) => c.split('=')[0]))
  ok('opening the link gives a session cookie', cookie)
  const r2 = await auth.handler(new Request(lastLink, { redirect: 'manual' }))
  ok('...and the link works once only', !(r2.headers.getSetCookie?.() || []).some((c) => /^(__Secure-)?better-auth\.session_token=/.test(c)))
  const cookieHdr = cookie.split(';')[0]
  const s = await auth.api.getSession({ headers: new Headers({ cookie: cookieHdr }) })
  ok('the cookie is alex\'s session', s?.user?.name === 'alex')
  const owner = await ctx.internalAdapter.createUser({ email: 'owner@users.mm.invalid', name: 'owner', emailVerified: true })
  const org = await auth.api.createOrganization({ body: { name: 'acme-shop', slug: 'acme-shop', userId: owner.id } })
  ok('an organization per project, made on the server', org?.id)
  await auth.api.addMember({ body: { userId: alex.id, organizationId: org!.id, role: 'designer' } })
  const members = await ctx.adapter.findMany<{ userId: string; role: string; organizationId: string }>({ model: 'member', where: [{ field: 'organizationId', value: org!.id }] })
  ok('a custom role (designer), added on the server with no email', members.some((m) => m.userId === alex.id && m.role === 'designer'))
  const roleOf = async (userId: string, slug: string) => {
    const o = await ctx.adapter.findOne<{ id: string }>({ model: 'organization', where: [{ field: 'slug', value: slug }] })
    const m = o && await ctx.adapter.findOne<{ role: string }>({ model: 'member', where: [{ field: 'organizationId', value: o.id }, { field: 'userId', value: userId }] })
    return m?.role || null
  }
  ok('the role from membership by project (the host\'s project), not the active organization', (await roleOf(alex.id, 'acme-shop')) === 'designer' && (await roleOf(alex.id, 'other')) === null)
  const token = decodeURIComponent(cookieHdr.slice(cookieHdr.indexOf('=') + 1)).split('.')[0]
  const sb = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) })
  ok('bearer: the session token works for a tool', sb?.user?.name === 'alex')
  await ctx.internalAdapter.deleteUserSessions(alex.id)
  ok('ending the person\'s sessions: the cookie is dead at once', !(await auth.api.getSession({ headers: new Headers({ cookie: cookieHdr }) })))
} catch (e) { fail++; console.log('  FAIL threw:', e instanceof Error ? `${e.name}: ${e.message} ${JSON.stringify((e as { body?: unknown }).body ?? '')}` : String(e), String((e as Error).stack || '').split('\n').slice(1, 3).join(' | ')) }
finally { rmSync(dir, { recursive: true, force: true }) }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0)
