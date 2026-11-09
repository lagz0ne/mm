// A small JSON Schema 2020-12 validator (sy-rfup): the subset the structured content's schemas use (bin/lib/schemas/),
// no dependency. Keywords: $id, $ref (in the same schema, "#/$defs/..."; or another registered one, "<$id>#/$defs/..."),
// $defs, $schema, $comment, title, description (annotations), type (one or a list), enum, const, pattern (a JS RegExp, u
// flag), minLength, maxLength (in code points), minimum, maximum, required, properties, additionalProperties,
// minProperties, maxProperties, items, minItems, maxItems, uniqueItems, allOf, anyOf, oneOf, not, if/then/else, and the
// boolean schemas true and false. Any other keyword is an error of the schema (SUPPORTED; test/schema.mjs checks that
// the schemas use only these), never silently ignored.
// The errors are short and say where: "<path>: <what is wrong>", the path dotted from the root ("expect.do",
// "parts[2].text"; the root is "(top)"). A then-branch's errors say its condition: "ready: not allowed (with intent ASK)".
// Pure, no imports; an identical copy is the board's browser code (site/src/lib/schema.mjs; test/schema.mjs keeps them equal).

export const SUPPORTED = new Set(['$id', '$ref', '$defs', '$schema', '$comment', 'title', 'description', 'type', 'enum', 'const',
  'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'required', 'properties', 'additionalProperties', 'minProperties',
  'maxProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else'])

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)
const isType = (v, t) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t)
const len = (s) => Array.from(s).length
const show = (v) => { const s = JSON.stringify(v); return s === undefined ? String(v) : s.length > 40 ? `${s.slice(0, 39)}…` : s }
const at = (p) => p || '(top)'
const key = (p, k) => (/^[A-Za-z_$][\w$-]*$/.test(k) ? (p ? `${p}.${k}` : k) : `${p}[${JSON.stringify(k)}]`)
const deep = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const reCache = new Map()
const re = (p) => { let r = reCache.get(p); if (!r) { r = new RegExp(p, 'u'); reCache.set(p, r) } return r }

/**
 * A validator over a set of schemas (each with an $id).
 * @param {object[]} schemas
 * @returns {{ validate: (id: string, value: unknown) => string[], schema: (id: string) => object, check: () => string[] }}
 *   validate: the errors of value against the schema with that $id ([] = valid); check: the problems of the schemas
 *   themselves (an unknown keyword, a $ref that leads nowhere)
 */
export function validator(schemas) {
  const docs = new Map()
  for (const s of schemas) { if (!s || typeof s.$id !== 'string') throw new Error('schema.mjs: every schema needs an $id'); docs.set(s.$id, s) }

  function resolve(ref, base) {
    const h = ref.indexOf('#')
    const id = h > 0 ? ref.slice(0, h) : h === 0 ? base : ref
    const doc = docs.get(id)
    if (!doc) throw new Error(`schema.mjs: $ref ${ref}: no schema ${id}`)
    let node = doc
    const ptr = h >= 0 ? ref.slice(h + 1) : ''
    for (const seg of ptr.split('/').filter(Boolean)) {
      node = node?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')]
      if (node === undefined) throw new Error(`schema.mjs: $ref ${ref}: nothing at ${ptr}`)
    }
    return { node, base: id }
  }

  /** The condition of an if, in words, for a then's errors: "with intent ASK". */
  function cond(s) {
    const ps = s && typeof s === 'object' && s.properties ? Object.entries(s.properties) : []
    const w = ps.map(([k, v]) => (v && 'const' in v ? `${k} ${typeof v.const === 'string' ? v.const : show(v.const)}` : v && v.type ? `${k} an ${v.type}` : null)).filter(Boolean)
    return w.length ? `with ${w.join(', ')}` : ''
  }

  function v(s, x, p, base, out) {
    if (s === true) return
    if (s === false) { out.push(`${at(p)}: not allowed`); return }
    if (!s || typeof s !== 'object') { out.push(`${at(p)}: the schema is not an object`); return }
    if (typeof s.$id === 'string') base = s.$id
    if (s.$ref !== undefined) { const r = resolve(s.$ref, base); v(r.node, x, p, r.base, out) }
    if (s.type !== undefined) {
      const ts = Array.isArray(s.type) ? s.type : [s.type]
      if (!ts.some((t) => isType(x, t))) { out.push(`${at(p)}: is ${typeOf(x) === 'integer' ? 'a number' : `${/^[aeiou]/.test(typeOf(x)) ? 'an' : 'a'} ${typeOf(x)}`}, not ${ts.join(' or ')}`); return }
    }
    if (s.const !== undefined && !deep(s.const, x)) out.push(`${at(p)}: is ${show(x)}, not ${show(s.const)}`)
    if (s.enum !== undefined && !s.enum.some((e) => deep(e, x))) out.push(`${at(p)}: ${show(x)} is not one of ${s.enum.map((e) => (typeof e === 'string' ? e : show(e))).join(', ')}`)
    if (typeof x === 'string') {
      if (s.minLength !== undefined && len(x) < s.minLength) out.push(`${at(p)}: ${s.minLength === 1 ? 'is empty' : `is ${len(x)} characters (at least ${s.minLength})`}`)
      if (s.maxLength !== undefined && len(x) > s.maxLength) out.push(`${at(p)}: is too long (${len(x)} characters; at most ${s.maxLength})`)
      if (s.pattern !== undefined && !re(s.pattern).test(x)) out.push(`${at(p)}: ${show(x)} does not match ${typeof s.description === 'string' ? `(${s.description})` : s.pattern}`)
    }
    if (typeof x === 'number') {
      if (s.minimum !== undefined && x < s.minimum) out.push(`${at(p)}: ${x} is less than ${s.minimum}`)
      if (s.maximum !== undefined && x > s.maximum) out.push(`${at(p)}: ${x} is more than ${s.maximum}`)
    }
    if (Array.isArray(x)) {
      if (s.minItems !== undefined && x.length < s.minItems) out.push(`${at(p)}: has ${x.length} item(s) (at least ${s.minItems})`)
      if (s.maxItems !== undefined && x.length > s.maxItems) out.push(`${at(p)}: has ${x.length} items (at most ${s.maxItems})`)
      if (s.uniqueItems && new Set(x.map((e) => JSON.stringify(e))).size !== x.length) out.push(`${at(p)}: has the same item twice`)
      if (s.items !== undefined) x.forEach((e, k) => v(s.items, e, `${p}[${k}]`, base, out))
    }
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      const ks = Object.keys(x)
      for (const r of s.required || []) if (!(r in x)) out.push(`${key(p, r)}: is missing`)
      if (s.minProperties !== undefined && ks.length < s.minProperties) out.push(`${at(p)}: needs at least ${s.minProperties} key(s)`)
      if (s.maxProperties !== undefined && ks.length > s.maxProperties) out.push(`${at(p)}: has more than ${s.maxProperties} keys`)
      const props = s.properties || {}
      for (const k of ks) {
        if (k in props) v(props[k], x[k], key(p, k), base, out)
        else if (s.additionalProperties === false) out.push(`${key(p, k)}: is not a key here (the keys: ${Object.keys(props).join(', ')})`)
        else if (s.additionalProperties !== undefined) v(s.additionalProperties, x[k], key(p, k), base, out)
      }
    }
    for (const sub of s.allOf || []) v(sub, x, p, base, out)
    if (s.anyOf) {
      const tries = s.anyOf.map((sub) => { const o = []; v(sub, x, p, base, o); return o })
      if (!tries.some((o) => !o.length)) out.push(...closest(tries, p, s.anyOf, x))
    }
    if (s.oneOf) {
      const tries = s.oneOf.map((sub) => { const o = []; v(sub, x, p, base, o); return o })
      const n = tries.filter((o) => !o.length).length
      if (n === 0 && s.oneOf.every((o) => o.required?.length === 1 && Object.keys(o).length === 1)) out.push(`${at(p)}: needs one of ${s.oneOf.map((o) => o.required[0]).join(', ')}`)
      else if (n === 0) out.push(...closest(tries, p, s.oneOf, x))
      else if (n > 1) out.push(`${at(p)}: matches ${n} of the forms, where exactly one is allowed${s.oneOf.every((o) => o.required?.length === 1) ? ` (one of ${s.oneOf.map((o) => o.required[0]).join(', ')})` : ''}`)
    }
    if (s.not !== undefined) { const o = []; v(s.not, x, p, base, o); if (!o.length) out.push(`${at(p)}: is a form that is not allowed here`) }
    if (s.if !== undefined) {
      const o = []; v(s.if, x, p, base, o)
      const branch = o.length ? s.else : s.then
      if (branch !== undefined) {
        const b = []; v(branch, x, p, base, b)
        const c = !o.length ? cond(s.if) : ''
        out.push(...b.map((e) => (c ? `${e} (${c})` : e)))
      }
    }
  }

  /** When no form fits: the errors of the form whose shape fits (the fewest), or one line naming the forms. */
  function closest(tries, p, subs, x) {
    const here = `${at(p)}: `, shapeMiss = (e) => e.startsWith(here) && /(, not |is not one of | does not match | is none of )/.test(e)
    const fit = tries.filter((o) => !o.some(shapeMiss))
    if (fit.length) return fit.sort((a, b) => a.length - b.length)[0]
    return [`${here}${show(x)} is none of the allowed forms (${subs.map(form).join(' | ')})`]
  }
  const form = (s) => (s === true ? 'anything' : !s || typeof s !== 'object' ? '?' : s.const !== undefined ? show(s.const)
    : typeof s.$ref === 'string' ? s.$ref.split('/').pop() : s.type && s.pattern ? `${s.type} ${s.pattern}` : s.type ? String(s.type)
    : s.required ? `with ${s.required.join(', ')}` : 'a form')

  function walk(s, where, out, base) {
    if (typeof s === 'boolean') return
    if (!s || typeof s !== 'object' || Array.isArray(s)) { out.push(`${where}: not a schema`); return }
    if (typeof s.$id === 'string') base = s.$id
    for (const k of Object.keys(s)) if (!SUPPORTED.has(k)) out.push(`${where}: keyword ${k} is not supported by bin/lib/schema.mjs`)
    if (s.$ref !== undefined) { try { resolve(s.$ref, base) } catch (e) { out.push(`${where}: ${e.message}`) } }
    if (s.pattern !== undefined) { try { re(s.pattern) } catch { out.push(`${where}: pattern ${s.pattern} is no RegExp`) } }
    for (const k of ['$defs', 'properties']) for (const [n, sub] of Object.entries(s[k] || {})) walk(sub, `${where}.${k}.${n}`, out, base)
    for (const k of ['allOf', 'anyOf', 'oneOf']) (s[k] || []).forEach((sub, i) => walk(sub, `${where}.${k}[${i}]`, out, base))
    for (const k of ['items', 'additionalProperties', 'not', 'if', 'then', 'else']) if (s[k] !== undefined) walk(s[k], `${where}.${k}`, out, base)
  }

  return {
    schema: (id) => docs.get(id),
    validate(id, value) {
      const doc = docs.get(id)
      if (!doc) throw new Error(`schema.mjs: no schema ${id}`)
      const out = []
      v(doc, value, '', id, out)
      return [...new Set(out)]
    },
    check() { const out = []; for (const [id, d] of docs) walk(d, id, out, id); return out },
  }
}
