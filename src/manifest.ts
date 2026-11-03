// The manifest is compiled into the binary: what a machine and a project need.
import manifestText from '../manifest.yaml' with { type: 'text' }

export type Install =
  | { kind: 'system'; packages: Record<'dnf' | 'apt' | 'apk', string> }
  | { kind: 'node-dist'; version: string }
  | { kind: 'npm'; package: string }
  | { kind: 'script'; url: string; root?: boolean; note?: string }
  | { kind: 'github-release'; repo: string; tag: string; asset: string; checksums?: string; checksum_suffix?: string; binary: string }

export interface Tool {
  required?: boolean
  optional?: boolean
  min?: string
  tested?: string
  version?: string[]
  when?: string
  with?: string
  install?: Install
  needed_by?: string
}
export interface Secret { path: string; used_by?: string; managed_by?: string }
export interface Manifest {
  version: number
  machine: {
    vars: Record<string, { ask?: string; default?: string; choices?: string[]; when?: string }>
    tools: Record<string, Tool>
    paths: Record<string, { path: string; git?: string }>
    secrets: Secret[]
    services: Record<string, { unit?: string; socket?: string; status?: string }>
  }
  project: Record<string, unknown>
}

export const manifest = Bun.YAML.parse(manifestText) as Manifest
export const manifestSource = manifestText
