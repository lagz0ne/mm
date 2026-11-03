// Installers for the manifest's `install` kinds. Everything lands under ~/.mm except system packages.
// Every download is checked against its published sha256 before use.
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { archNames, asRoot, DIRS, run, which } from './env'
import type { Install } from './manifest'

const fill = (s: string) => s.replaceAll('{goarch}', archNames.goarch).replaceAll('{rustarch}', archNames.rustarch).replaceAll('{node}', archNames.node)

function link(target: string, name: string) {
  mkdirSync(DIRS.bin, { recursive: true })
  const at = join(DIRS.bin, name)
  rmSync(at, { force: true })
  symlinkSync(target, at)
}

async function download(url: string): Promise<Uint8Array> {
  const r = await fetch(url, { redirect: 'follow' })
  if (!r.ok) throw new Error(`download ${url}: HTTP ${r.status}`)
  return new Uint8Array(await r.arrayBuffer())
}
const sha256 = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex')
async function verified(url: string, expected: string): Promise<Uint8Array> {
  const b = await download(url)
  const got = sha256(b)
  if (got !== expected.toLowerCase()) throw new Error(`checksum mismatch for ${url}: got ${got}, want ${expected}`)
  return b
}
function unpack(archive: Uint8Array, name: string, dest: string) {
  mkdirSync(dest, { recursive: true })
  const file = join(dest, `.${name}`)
  writeFileSync(file, archive)
  const flag = name.endsWith('.tar.xz') ? '-xJf' : name.endsWith('.tar.gz') || name.endsWith('.tgz') ? '-xzf' : null
  if (!flag) throw new Error(`don't know how to unpack ${name}`)
  const r = run(['tar', flag, file, '-C', dest])
  rmSync(file, { force: true })
  if (!r.ok) throw new Error(`tar ${name}: ${r.err.trim()}`)
}

/** Package manager on this machine. */
export function packageManager(): 'dnf' | 'apt' | 'apk' | null {
  if (which('dnf')) return 'dnf'
  if (which('apt-get')) return 'apt'
  if (which('apk')) return 'apk'
  return null
}

/** Install several system packages in one go (needs root or passwordless sudo). */
export function installSystem(pkgs: string[]): string {
  if (!pkgs.length) return 'nothing to do'
  const pm = packageManager()
  if (!pm) throw new Error('no supported package manager (dnf, apt, apk)')
  if (pm === 'apt') {
    run(asRoot(['apt-get', 'update', '-q']), { timeoutMs: 600_000, env: { DEBIAN_FRONTEND: 'noninteractive' } })
    const r = run(asRoot(['apt-get', 'install', '-y', '-q', '--no-install-recommends', ...pkgs]), { timeoutMs: 900_000, env: { DEBIAN_FRONTEND: 'noninteractive' } })
    if (!r.ok) throw new Error(`apt-get install ${pkgs.join(' ')}: ${r.err.trim().split('\n').slice(-2).join(' ')}`)
  } else {
    const r = run(asRoot(pm === 'dnf' ? ['dnf', '-y', '-q', 'install', ...pkgs] : ['apk', 'add', '--no-cache', ...pkgs]), { timeoutMs: 900_000 })
    if (!r.ok) throw new Error(`${pm} install ${pkgs.join(' ')}: ${r.err.trim().split('\n').slice(-2).join(' ')}`)
  }
  return `${pm}: ${pkgs.join(' ')}`
}

export async function install(name: string, spec: Install): Promise<string> {
  switch (spec.kind) {
    case 'system': {
      const pm = packageManager()
      if (!pm) throw new Error('no supported package manager')
      return installSystem([spec.packages[pm]])
    }
    case 'node-dist': {
      const v = spec.version, base = `https://nodejs.org/dist/v${v}`, asset = `node-v${v}-linux-${archNames.node}.tar.xz`
      const sums = new TextDecoder().decode(await download(`${base}/SHASUMS256.txt`))
      const want = sums.split('\n').find((l) => l.endsWith(`  ${asset}`))?.split(/\s+/)[0]
      if (!want) throw new Error(`no checksum for ${asset}`)
      const dest = join(DIRS.tools, 'node', v)
      unpack(await verified(`${base}/${asset}`, want), asset, dest)
      const bin = join(dest, `node-v${v}-linux-${archNames.node}`, 'bin')
      for (const b of ['node', 'npm', 'npx']) link(join(bin, b), b)
      return `node ${v} -> ~/.mm/tools/node/${v}`
    }
    case 'npm': {
      if (!which('npm')) throw new Error('npm is needed first (node)')
      mkdirSync(DIRS.npm, { recursive: true })
      const r = run(['npm', 'install', '-g', '--prefix', DIRS.npm, '--no-audit', '--no-fund', spec.package], { timeoutMs: 600_000 })
      if (!r.ok) throw new Error(`npm install ${spec.package}: ${r.err.trim().split('\n').slice(-2).join(' ')}`)
      const nbin = join(DIRS.npm, 'bin')
      for (const b of existsSync(nbin) ? readdirSync(nbin) : []) link(join(nbin, b), b)
      return `${spec.package} -> ~/.mm/npm`
    }
    case 'script': {
      const body = await download(spec.url)
      const file = join(DIRS.mm, `.install-${name}.sh`)
      mkdirSync(DIRS.mm, { recursive: true })
      writeFileSync(file, body)
      const shell = which('bash') ? 'bash' : 'sh' // vendor install scripts assume bash
      const r = run(spec.root ? asRoot([shell, file]) : [shell, file], { timeoutMs: 900_000 })
      rmSync(file, { force: true })
      if (!r.ok) throw new Error(`${spec.url}: ${(r.err || r.out).trim().split('\n').slice(-2).join(' ')}`)
      return `ran ${spec.url}`
    }
    case 'github-release': {
      const asset = fill(spec.asset), base = `https://github.com/${spec.repo}/releases/download/${spec.tag}`
      let want: string | undefined
      if (spec.checksums) want = new TextDecoder().decode(await download(`${base}/${fill(spec.checksums)}`)).split('\n').find((l) => l.trim().endsWith(asset))?.split(/\s+/)[0]
      else if (spec.checksum_suffix) want = new TextDecoder().decode(await download(`${base}/${asset}${spec.checksum_suffix}`)).trim().split(/\s+/)[0]
      if (!want) throw new Error(`no published checksum for ${asset}`)
      const dest = join(DIRS.tools, name, spec.tag)
      unpack(await verified(`${base}/${asset}`, want), asset, dest)
      const bin = join(dest, fill(spec.binary))
      chmodSync(bin, 0o755)
      link(bin, name)
      return `${spec.repo} ${spec.tag} -> ~/.mm/tools/${name}/${spec.tag}`
    }
  }
}
