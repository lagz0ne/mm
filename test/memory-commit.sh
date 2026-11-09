#!/usr/bin/env bash
# bin/memory-commit, the board committing its leads' memory notes by itself (sy-3wn3), hermetic: a throwaway HOME /
# MM_HOME and a board rendered from mm's template as mm new lays it out, in its own git repo (nothing started).
# Proves: config-check renders the note hook (PostToolUse) into every lead's and setup's settings; the hook records who
# wrote a note, through the Claude memory link too, and ignores a path outside memory/ or an unknown role; a pass commits
# a new note with its role as author, one commit per role, "memory: <role>'s notes (<files>)"; a note without the
# author falls back to "memory <project>"; a note failing config-check's memory rules or the secret scan stays
# uncommitted and is said once (again when it changes); other dirty or staged files stay as they were; a removed note is
# committed as removed; no pass while index.lock or a merge is there; a folder that is not its repo's top commits nothing.
#   test/memory-commit.sh
set -uo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  \e[32mok\e[0m   %s\n' "$*"; }
bad()  { fail=$((fail+1)); printf '  \e[31mFAIL\e[0m %s\n' "$*"; }
check() { local d=$1; shift; if "$@" >"$T/check.out" 2>&1; then ok "$d"; else bad "$d"; tail -5 "$T/check.out" | sed 's/^/       /'; fi; }
T=$(mktemp -d); trap '[ -n "${KEEP:-}" ] && echo "kept $T" || rm -rf "$T"' EXIT
export HOME="$T/home" MM_HOME="$T/home/.mm" MM_OBS_TRACES="" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
unset MM_BRAIN MM_PROJECTS MM_SYSTEM MM_BACKUPS MM_PROJECT
mkdir -p "$HOME"
cat >"$T/stamp.ts" <<EOF
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderTo, template } from '$SRC/src/template'
import { templateVars } from '$SRC/src/project'
const [root] = process.argv.slice(2), t = template()
mkdirSync(root, { recursive: true })
writeFileSync(join(root, '.mm-answers.yaml'), Bun.YAML.stringify({ client: 'acme', name: 'shop', project: 'acme-shop', short: 'sh', root,
  template_version: t.version, created: new Date().toISOString(), throwaway: true }, null, 2) + '\n')
renderTo(root, templateVars(root), t)
EOF
P="$MM_HOME/projects/acme/shop"
PATH="$HOME/.bun/bin:$PATH" bun "$T/stamp.ts" "$P" >/dev/null || { echo "stamp failed"; exit 1; }
g() { git -C "$P" "$@"; }
g init -q -b main && g -c user.name=t -c user.email=t@t add -A && g -c user.name=t -c user.email=t@t commit -qm init || { echo "git init failed"; exit 1; }
mc() { (cd "$P" && node bin/memory-commit "$@"); }
hook() { local role=$1 file=$2; printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$file" | (cd "$P" && node bin/memory-commit note "$role"); }
note() { printf -- '---\nname: %s\ndescription: a fact\nmetadata:\n  type: project\n  verified: 2026-01-01\n  ttl_days: 30\n---\n%s\n' "$1" "${2:-the fact}" >"$P/memory/$1.md"; }
author() { g log -1 --format=%an -- "memory/$1"; }
committed() { g cat-file -e "HEAD:memory/$1"; }
clean() { [ -z "$(g status --porcelain -- "memory/$1")" ]; }

echo "== config-check renders the note hook into every lead's and setup's settings"
check "the project renders (config-check --render)" bash -c "cd '$P' && node bin/config-check --render"
check "each lead's and setup's settings run 'bin/memory-commit note <its role>' after Write|Edit|MultiEdit" bash -c '
  for f in "$1"/leads/*/.claude/settings.json "$1"/setup/.claude/settings.json; do r=$(basename "$(dirname "$(dirname "$f")")")
    jq -e --arg c "$1/bin/memory-commit note $r || true" "[.hooks.PostToolUse[] | select(.matcher == \"Write|Edit|MultiEdit\") | .hooks[].command] | index(\$c) != null" "$f" >/dev/null || { echo "$f"; exit 1; }; done' _ "$P"
check "config-check passes on the rendered board" bash -c "cd '$P' && node bin/config-check"

echo "== the hook records who wrote a note"
note ops-fact
LINK="$T/claude/projects/x/memory"; mkdir -p "$(dirname "$LINK")"; ln -s "$P/memory" "$LINK"
note code-fact
hook ops "$P/memory/ops-fact.md"
hook code "$LINK/code-fact.md"
hook ops "$P/CLAUDE.md"; hook intruder "$P/memory/ops-fact.md"; hook ops "/tmp/elsewhere/x.md"
check "two lines: ops (direct), code (through the link); not a file outside memory/, not an unknown role" bash -c "
  [ \$(wc -l <'$P/.run/memory-authors.log') = 2 ] && grep -qP '\tops\tops-fact.md\$' '$P/.run/memory-authors.log' && grep -qP '\tcode\tcode-fact.md\$' '$P/.run/memory-authors.log'"
check "a hook given junk says nothing and exits 0" bash -c "echo 'not json' | (cd '$P' && node bin/memory-commit note ops) | grep -c . | grep -qx 0"

echo "== a pass commits each role's notes as that role"
echo 'other work' >>"$P/CLAUDE.md"; echo 'staged elsewhere' >"$P/ops/staged.txt"; g add ops/staged.txt
note anon-fact; printf -- '- [x](ops-fact.md) — x\n' >>"$P/memory/MEMORY.md"; hook ops "$P/memory/MEMORY.md"
before=$(g rev-list --count HEAD)
out=$(mc); echo "$out" >"$T/pass1.out"
check "three commits: ops, code, and the fallback" bash -c "[ \$(git -C '$P' rev-list --count HEAD) = $((before + 3)) ]"
check "ops-fact.md and MEMORY.md: one commit by ops, 'memory: ops's notes (MEMORY.md, ops-fact.md)'" bash -c "
  [ \"\$(git -C '$P' log -1 --format=%an -- memory/ops-fact.md)\" = ops ] && git -C '$P' log --format=%s | grep -qxF \"memory: ops's notes (MEMORY.md, ops-fact.md)\" && [ \"\$(git -C '$P' log -1 --format=%H -- memory/ops-fact.md)\" = \"\$(git -C '$P' log -1 --format=%H -- memory/MEMORY.md)\" ]"
check "code-fact.md by code (written through the link)" bash -c "[ \"\$(git -C '$P' log -1 --format='%an <%ae>' -- memory/code-fact.md)\" = 'code <code@acme-shop.local>' ]"
check "a note with no recorded author: 'memory acme-shop'" bash -c "[ \"\$(git -C '$P' log -1 --format=%an -- memory/anon-fact.md)\" = 'memory acme-shop' ]"
check "each commit holds memory/ files only" bash -c "! git -C '$P' log -3 --name-only --format= | grep -v '^memory/' | grep -q ."
check "the other dirty file stays uncommitted (still modified)" bash -c "git -C '$P' status --porcelain -- CLAUDE.md | grep -q '^ M'"
check "the staged file stays staged, uncommitted" bash -c "git -C '$P' status --porcelain -- ops/staged.txt | grep -q '^A ' && ! git -C '$P' cat-file -e HEAD:ops/staged.txt"
check "the committed notes are clean (index and tree)" bash -c "[ -z \"\$(git -C '$P' status --porcelain -- memory/)\" ]"
check "the author log forgot them" bash -c "! grep -q . '$P/.run/memory-authors.log' 2>/dev/null"
check "a second pass commits nothing" bash -c "n=\$(git -C '$P' rev-list --count HEAD); cd '$P' && node bin/memory-commit >/dev/null && [ \$(git -C '$P' rev-list --count HEAD) = \$n ]"

echo "== a note that fails stays uncommitted, said once"
printf -- '---\nname: no-dates\ndescription: x\n---\nbody\n' >"$P/memory/no-dates.md"; hook ops "$P/memory/no-dates.md"
note leaky "token ghp_$(printf 'a%.0s' {1..36})"; hook ops "$P/memory/leaky.md"
note good; hook ops "$P/memory/good.md"
mc >"$T/p2.out" 2>"$T/p2.err"
check "the good note is committed" committed good.md
check "no-dates.md (no verified/ttl_days) is not committed" bash -c "! git -C '$P' cat-file -e HEAD:memory/no-dates.md"
check "leaky.md (a GitHub token) is not committed" bash -c "! git -C '$P' cat-file -e HEAD:memory/leaky.md"
check "each is said: why, and never the secret itself" bash -c "grep -q 'memory/no-dates.md: not committed: needs verified' '$T/p2.err' && grep -q 'memory/leaky.md: not committed: looks like a GitHub token' '$T/p2.err' && ! grep -q ghp_ '$T/p2.err'"
mc >"$T/p3.out" 2>"$T/p3.err"
check "the next pass says nothing again" bash -c "! grep -q . '$T/p3.err'"
echo 'more' >>"$P/memory/no-dates.md"; mc >/dev/null 2>"$T/p4.err"
check "...until the note changes" grep -q 'memory/no-dates.md: not committed' "$T/p4.err"
check "their author lines stay (for when they are fixed)" bash -c "grep -qP '\tops\tno-dates.md\$' '$P/.run/memory-authors.log'"
note no-dates; mc >/dev/null 2>&1
check "fixed: committed, by the role that wrote it" bash -c "[ \"\$(git -C '$P' log -1 --format=%an -- memory/no-dates.md)\" = ops ]"
rm -f "$P/memory/leaky.md"

echo "== a removed note, and git busy"
rm "$P/memory/good.md"; hook setup "$P/memory/good.md"; mc >/dev/null
check "a removed note is committed as removed (by the last writer)" bash -c "! git -C '$P' cat-file -e HEAD:memory/good.md && [ \"\$(git -C '$P' log -1 --format=%an -- memory/good.md)\" = setup ]"
note busy-fact; touch "$P/.git/index.lock"
check "index.lock there: busy, nothing committed" bash -c "cd '$P' && node bin/memory-commit | grep -q 'busy (index.lock)' && ! git -C '$P' cat-file -e HEAD:memory/busy-fact.md"
rm -f "$P/.git/index.lock"; g rev-parse HEAD >"$P/.git/MERGE_HEAD"
check "a merge in progress: busy, nothing committed" bash -c "cd '$P' && node bin/memory-commit | grep -q 'busy (a merge)' && ! git -C '$P' cat-file -e HEAD:memory/busy-fact.md"
rm -f "$P/.git/MERGE_HEAD"; mc >/dev/null
check "free again: committed" committed busy-fact.md

echo "== only the board's own repo"
O="$T/outer"; mkdir -p "$O"; git -C "$O" init -q; cp -r "$P/bin" "$P/leads" "$P/.mm-answers.yaml" "$O/" 2>/dev/null; mkdir -p "$O/sub"; mv "$O/bin" "$O/leads" "$O/.mm-answers.yaml" "$O/sub/"; mkdir -p "$O/sub/memory"
printf -- '---\nname: x\ndescription: x\nmetadata:\n  verified: 2026-01-01\n  ttl_days: 1\n---\n' >"$O/sub/memory/x.md"
check "a board folder inside another repo commits nothing there" bash -c "cd '$O/sub' && node bin/memory-commit && ! git -C '$O' rev-parse -q --verify HEAD"
check "no repo at all: exits 0, says nothing" bash -c "D='$T/norepo'; mkdir -p \$D; cp -r '$P/bin' \$D/; mkdir -p \$D/memory; cd \$D && [ -z \"\$(node bin/memory-commit 2>&1)\" ]"

echo
echo "memory-commit: $pass passed, $fail failed"
[ "$fail" = 0 ]
