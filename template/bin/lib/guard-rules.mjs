// guard-rules — what bin/guard denies, as plain data (sy-8t0.5). One list for every board's leads and setup.
//
// The block between BEGIN RULES and END RULES is strict JSON, so a guard in another language reads the same list:
//   Python: t = open(p).read(); d = json.loads(t.split('// BEGIN RULES\n', 1)[1].split('// END RULES', 1)[0])
// Every regex is written for both JavaScript and Python's re (no named groups, fixed-width lookbehind only, no flags).
//
// parts: fragments a rule names as {{NAME}} (expanded until none is left). ROOT and OWNER are not here: the guard
//   fills ROOT with the board's own folder (absolute, ~ and $HOME forms, escaped) and OWNER with the owner's name
//   (owner_name in the board's .run/endpoints.json, mm writes it; any case); another guard fills its own, or (?!) for none.
//   CMD     command position: line start, after ; & | ( ) { } ! newline backtick $(, a quote after -c / eval / ( [ ,
//           (bash -c '…', os.system('…'), ["sudo", …]), -exec, and after a wrapper (env, exec, nohup, nice, timeout N,
//           xargs, time, stdbuf, setsid, eval, watch, flock F, runuser, ssh HOST, which, sudo, doas, …) and its options
//   PRE     VAR=value words, a backslash, a quote and a path before the command's name (\sudo, "/usr/bin/sudo")
//   MM      mm as the command, with its global options
//   SEG     a command segment that does not start with ls, stat, test, du or [ (a listing stays free)
//   SECRET  a secret path (the brain guard's SECRET_PATHS, plus mm's Paseo passwords, the board's own secrets/ and the
//           approval signer's private/ folder)
//   DUMP    a verb that reads a file out (cat, grep, cp, curl, python3, node, base64, <, …)
//   WRITE   a verb that writes a file (sed -i, tee, >, cp, mv, rm, install, ln, truncate, open(…), …)
//   APPROVAL the approval path's files: Claude settings (not the .tmpl.json the setup agent edits) and hooks, this
//           guard (the board's own bin/guard, not a template copy elsewhere), the bridge, mm's process definitions, and
//           the board's .run/endpoints.json (mm writes it: the gateway's key the board checks, the owner's name) and its
//           supervisor.json (bin/supervisor's approver list, sy-1jmi), the ledger's verifier bin/lib/ledger.mjs, and
//           the signer's root-owned switch /etc/mm-approve.conf and its folder /var/lib/mm-approve/ (sy-4py1)
//   APPROVAL_BASE those files by base name, wherever the shell is (endpoints.json, supervisor.json, bin/guard,
//           guard-rules.mjs, ledger.mjs, mm-approve.conf, ledger.jsonl, mm-approve; not under /tmp/, not mm's own
//           template/bin/guard, template/bin/lib/ledger.mjs or box/mm-approve): bash only, a file tool's path is absolute
//   APPROVER an actor whose `approved` counts (bin/supervisor, bin/flow): the bridge's (`bridge`) and the owner's name
//   BD      bd as a command word (bd, bin/bd, ~/.mm/…/bin/bd, "bd"), then a space
// rules, checked in order; the first that matches denies with its reason:
//   on: bash (tool_input.command) | file (Read Edit Write MultiEdit NotebookEdit Grep Glob: the path) | file-write (not
//       Read, Grep or Glob). re must match; and, if given, must match too.
//   A bash rule sees the command in several forms (sy-in54; bin/guard's forms()): raw; dequoted as the shell would
//   (\-newlines joined, quotes and backslashes dropped, $'…' decoded) with // /./ and a leading ./ resolved; that with
//   the wrappers stripped at each command position (VAR=x, env, ionice, nice, timeout N, xargs, command, exec, sh -c, …;
//   /usr/bin/ps named ps); and with quoted argv lists (["bd", "label", …]) read as words. And a word with a glob is
//   also tried as each sensitive name the glob can match. A match on any form denies.
//   pre: checked before the board-only free path (a bd command with read-only steps around it: its text never runs).
//   boards: project = not on the system board (its ops and review use sudo -n for machine facts; the brain's guard and
//       the program govern them there).
// Accepted limits, as for the brain's guard: indirection defeats patterns (X=sudo; $X …, a script file), and prose that
// names a command in command position is denied too (pass long text through a file, or bd -f / git commit -F).
export const RULES = // BEGIN RULES
{
  "version": 1,
  "parts": {
    "CMD": "(?:^|[;&|(){}!\\n`]\\s*|\\$\\(\\s*|\\s-\\w*c\\s+['\"]\\s*|\\beval\\s+['\"]\\s*|[(\\[,]\\s*['\"]\\s*|\\s-exec(?:dir)?\\s+|\\b(?:then|do|else|exec|nohup|nice|command|builtin|xargs|time|stdbuf|setsid|eval|watch|runuser|systemd-run|chroot|nsenter|unshare|which|sudo|doas|run0)\\s+(?:(?:-\\S*|\\w+=\\S*)(?:\\s+[^\\s-]\\S*)?\\s+)*(?:--\\s+)?|\\benv\\s+(?:(?:-\\S+(?:\\s+\\w+)?|\\w+=\\S*)\\s+)*|\\b(?:timeout|flock|ssh)\\s+(?:-\\S+(?:\\s+\\S+)?\\s+)*\\S+\\s+)",
    "PRE": "(?:\\w+=\\S*\\s+)*\\\\?['\"]?(?:\\S*/)?",
    "MM": "{{CMD}}{{PRE}}mm['\"]?(?:\\s+-{1,2}[\\w-]+(?:\\s+(?:json|yaml|table))?)*\\s+",
    "SEG": "(?:^|[;&|\\n()`])\\s*(?!(?:ls|stat|test|du|\\[)\\s)[^;&|\\n()`]*",
    "MMDIR": "(?:\\.mm|\\$\\{?MM_HOME\\}?)",
    "SECRET": "(?:(?<![\\w.-])\\.keys/|/mm-approve/private(?![\\w.-])|/brain/\\.keys\\b|/etc/cloudflared/\\S*token|\\.config/secrets/|(?:\\.paseo|\\.mm/paseo/[\\w.-]+)/(?:daemon-keypair\\.json|local-credential)|{{MMDIR}}/paseo/[\\w.-]+\\.password\\b|/etc/g?shadow|ssh_host_\\w+_key(?!\\.pub)|\\.cloudflared/[^ ]*\\.json|/etc/cloudflared/[^ ]*\\.json|\\.claude/\\.credentials|\\.ssh/(?!(?:known_hosts(?:\\.old)?|authorized_keys|config)(?![\\w.-]))[\\w.-]+(?<!\\.pub)(?![\\w.-])|\\.ssh/[\\w.-]*[*?\\[]|\\b(?:tar|zip|7z|cp\\s+-\\w*r\\w*|rsync|scp)\\b[^;&|]*\\.ssh/?(?:\\s|$)|\\.mm/vault/key\\b|/vault/key\\b|/mm/secrets(?:/|\\b)|AGE-SECRET-KEY-|{{MMDIR}}/(?:auth|ai|api)/|\\.config/gh/hosts\\.yml|\\bgh[pos]_[A-Za-z0-9]{20,}|(?:^|[\\s'\"=(<:])(?:\\.\\.?/)*secrets/|/projects/(?:[\\w.-]+/){1,2}secrets/|{{ROOT}}/secrets/)",
    "SECRET_DIR": "(?:\\.ssh|\\.keys|\\.config/secrets|\\.paseo|{{MMDIR}}/(?:auth|ai|api|paseo|vault)|/mm/secrets|/projects/(?:[\\w.-]+/){1,2}secrets|{{ROOT}}/secrets)/?$",
    "DUMP": "(?:\\b(?:cat|less|more|head|tail|bat|batcat|xxd|od|hexdump|strings|base64|base32|basenc|grep|egrep|fgrep|zgrep|rg|ag|awk|gawk|sed|cut|tr|sort|uniq|diff|cmp|comm|join|paste|tac|nl|rev|fold|column|pr|expand|iconv|cp|mv|ln|install|scp|rsync|curl|wget|nc|ncat|socat|tee|printf|echo|read|mapfile|readarray|source|vi|vim|view|nano|emacs|python3?|node|bun|deno|perl|ruby|php|lua|jq|yq|sqlite3|tar|zip|7z|gzip|gunzip|zcat|bzip2|xz|zstd|dd|openssl|gpg|age|xargs|split)\\b|<|(?:^|[;&|]\\s*)\\.\\s+\\S)",
    "WRITE": "(?:\\bsed\\s+(?:-\\w+\\s+)*-i|\\bperl\\s+(?:-\\w+\\s+)*-\\w*i|\\btee\\b|>>?|\\b(?:cp|mv|rm|install|ln|truncate|chmod|chown|touch|patch|dd|rsync|unlink)\\b|\\b(?:open|write\\w*|append\\w*)\\(\\s*['\"]?)",
    "APPROVER": "(?:[bB][rR][iI][dD][gG][eE]|{{OWNER}})",
    "BD": "(?:^|[\\s;&|(){}`'\"/])bd['\"]?(?=\\s)",
    "APPROVAL": "(?:\\.claude/settings(?!\\.tmpl)[\\w.-]*\\.json|\\.claude/hooks/|\\.local/lib/(?:paseo-telegram|brain)/|{{MMDIR}}/(?:claude/(?:[\\w.-]+/)?settings[\\w.-]*\\.json|pc/[\\w.-]+\\.ya?ml)|(?:^|(?<=[\\s'\"=<>]))(?:\\.\\./)*bin/(?:guard|lib/(?:guard-rules|ledger)\\.mjs)(?![\\w.-])|{{ROOT}}/bin/(?:guard|lib/(?:guard-rules|ledger)\\.mjs)(?![\\w.-])|(?:^|(?<=[\\s'\"=<>]))(?:\\.\\./)*\\.run/endpoints\\.json(?![\\w.-])|{{ROOT}}/\\.run/endpoints\\.json(?![\\w.-])|(?:^|(?<=[\\s'\"=<>]))(?:\\.\\./)*supervisor\\.json(?![\\w.-])|{{ROOT}}/supervisor\\.json(?![\\w.-])|/etc/mm-approve\\.conf(?![\\w.-])|/var/lib/mm-approve(?![\\w.-]))",
    "APPROVAL_BASE": "(?:^|(?<=[\\s'\"=<>:]))(?!/tmp/)(?:[^\\s'\"=<>;&|]*/)?(?:endpoints\\.json|supervisor\\.json|guard-rules\\.mjs|(?<!template/)bin/guard|(?<!template/bin/lib/)ledger\\.mjs|mm-approve\\.conf|ledger\\.jsonl|(?<!box/)mm-approve)(?![\\w.-])"
  },
  "rules": [
    {
      "id": "secret-read",
      "on": "bash",
      "pre": true,
      "re": "{{SECRET}}",
      "and": "{{DUMP}}",
      "why": "reads secret material into the transcript. Refer to a secret by its path only; check it with ls -l, stat or test -s."
    },
    {
      "id": "secret-cd",
      "on": "bash",
      "pre": true,
      "re": "\\b(?:cd|pushd)\\s+['\"]?(?:(?:\\S*/)?(?:\\.ssh|\\.keys|\\.config/secrets|\\.paseo)|(?:\\.\\.?/)*secrets|\\S*{{MMDIR}}/(?:auth|ai|api|paseo|vault)|\\S*/mm/secrets|\\S*/projects/(?:[\\w.-]+/){1,2}secrets|{{ROOT}}/secrets)/?['\"]?(?=\\s|[;&|)]|$)",
      "and": "{{DUMP}}",
      "why": "changes into a secret folder and reads there; secrets are never read into the transcript."
    },
    {
      "id": "mm-store",
      "on": "bash",
      "pre": true,
      "re": "{{SEG}}{{MMDIR}}/(?:auth|ai|api)(?:/|\\b)",
      "why": "touches a store of mm's gateways (sign-in, AI, project API): only mm opens it. A listing (ls, stat, test, du) is fine."
    },
    {
      "id": "secret-file",
      "on": "file",
      "re": "{{SECRET}}",
      "why": "a secret file or mm store: never load its contents. Check it with ls -l instead."
    },
    {
      "id": "secret-dir",
      "on": "file",
      "re": "{{SECRET_DIR}}",
      "why": "searches a secret folder: never load its contents."
    },
    {
      "id": "proc-env",
      "on": "bash",
      "pre": true,
      "re": "(?:/proc/[^\\s'\"`;|&<>]*/mem|/(?:environ|cmdline|auxv))(?![\\w.-])|\\b(?:cd|pushd)\\s[^\\n]*?(?:^|[\\s<'\"=(])(?:environ|cmdline|auxv)(?![\\w.-])|\\b(?:cd|pushd)\\s+\\S*/proc\\b[^\\n]*?(?:^|[\\s<'\"=(])mem(?![\\w.-])",
      "why": "reads another process's environment or command line (/proc/<pid>/environ, cmdline): tokens live there. Use ps -o pid,comm, or the named /proc files (meminfo, loadavg, uptime, pressure)."
    },
    {
      "id": "proc-env-file",
      "on": "file",
      "re": "/proc/[^\\s'\"`]*(?:environ|cmdline|auxv|/mem)(?![\\w.-])",
      "why": "reads another process's environment or command line: tokens live there."
    },
    {
      "id": "proc-dir",
      "on": "file",
      "re": "^/proc(?:/(?:\\d+|self|thread-self)(?:/task(?:/\\d+)?)?)?/?$",
      "why": "searches a process's /proc folder, where its environment and command line are: tokens live there."
    },
    {
      "id": "ps-env",
      "on": "bash",
      "pre": true,
      "re": "(?:^|[\\s;&|(`$])ps\\s+[a-zA-Z]*e[a-zA-Z]*(?=$|[\\s|;&)`])|(?:^|[;&|(){}`\\n])\\s*ps(?:\\s+[^\\s;&|`)]+)*?\\s+[^\\s;&|`)-][^\\s;&|`)]*\\s+[a-zA-Z]*e[a-zA-Z]*(?=$|[\\s|;&)`])",
      "why": "ps with its BSD-style e option prints every process's environment, where tokens live. Use ps -ef or ps -o."
    },
    {
      "id": "git-grep-pager",
      "on": "bash",
      "pre": true,
      "re": "(?:^|[\\s;&|(`/])git\\b[^;&|\\n]*?\\sgrep\\b[^;&|\\n]*?\\s(?:-[A-Za-z0-9]*O|--op[\\w-]*)",
      "why": "git grep -O (--open-files-in-pager) runs a program on the files it finds: a search that runs code. Use git grep -n or -l and read the files."
    },
    {
      "id": "sudo",
      "on": "bash",
      "boards": "project",
      "re": "{{CMD}}{{PRE}}(?:sudo|sudoedit|doas|pkexec|run0|su)['\"]?(?![\\w.-])",
      "why": "runs a command as another user (sudo, doas, pkexec, su): a lead never does. Ask the owner on the board."
    },
    {
      "id": "mm-owner",
      "on": "bash",
      "re": "{{MM}}(?:user|grant|token|auth|api|fill|link|ai\\s+budget|vault\\s+(?:run|init))(?![\\w-])",
      "why": "an owner-only mm command (people, grants, sign-in links, tokens, sign-in approval, AI budgets, project API decisions, the vault's opener, filling secrets): the owner runs it in their own terminal."
    },
    {
      "id": "mm-socket",
      "on": "bash",
      "re": "{{SEG}}\\b(?:auth|ai|approve)\\.sock\\b",
      "why": "talks to an owner socket of mm (sign-in, AI, project API) directly: only mm and the owner's bridge do."
    },
    {
      "id": "doop-key",
      "on": "bash",
      "re": "{{CMD}}{{PRE}}doop-mcp-headers\\b|\\b(?:ba|z|da)?sh\\s+\\S*doop-mcp-headers\\b|\\b(?:node|bun)\\s+\\S*doop-mcp-headers\\b",
      "why": "runs the helper that prints the Doop key: only Claude Code runs it (headersHelper)."
    },
    {
      "id": "token-print",
      "on": "bash",
      "re": "\\bgit\\b[^;&|]*\\scredential\\s+(?:fill|get)\\b|\\bgit[- ]credential-[\\w-]+\\s+get\\b|\\bgh\\b[^;&|\\n]*\\sauth\\s+(?:token|git-credential)\\b|\\bgh\\b[^;&|\\n]*\\sauth\\s+status\\b[^;&|\\n]*\\s(?:-t|--show-token)\\b|\\bgh\\b[^;&|\\n]*\\sconfig\\s+(?:get|set)\\s+(?:-\\S+\\s+)*oauth_token\\b",
      "why": "prints a stored password or token: secrets are never printed."
    },
    {
      "id": "board-out",
      "on": "bash",
      "re": "(?:^|[\\s;&|(])(?:\\S*/)?bd\\b[^;&|\\n]*\\s(?:dolt\\s+(?:remote\\s+add|push)|sync|federation|github|gitlab|jira|linear|notion|ado|ship)\\b|(?:^|[\\s;&|(])(?:\\S*/)?dolt\\s+(?:-\\S+\\s+)*(?:push|remote\\s+(?:add|set-url))\\b",
      "why": "sends the board to a remote: the owner runs it in their own terminal."
    },
    {
      "id": "permit",
      "on": "bash",
      "re": "(?:\\bpaseo\\b|@getpaseo/)[^;&|]*\\bpermit\\b[^;&|]*\\s(?:allow|deny|approve|reject|respond)\\b",
      "why": "answers a permission request: only the human approves."
    },
    {
      "id": "approver-actor",
      "on": "bash",
      "pre": true,
      "re": "(?:--actor['\"]?(?:=|\\s+)|\\b(?:BEADS_ACTOR|BD_ACTOR|USER|LOGNAME)=|\\buser\\.name['\"]?(?:=|\\s+))['\"]?{{APPROVER}}['\"]?(?![\\w.-])|\\bxargs\\b[^;&|\\n]*--actor(?:=|\\s+)?(?:\\{\\}|\\s*(?=$|[;&|\\n)]))",
      "why": "writes to the board as an approver (the bridge or the owner): only their own `approved` counts, so an agent never writes under their name. Write as yourself; the owner approves on the board's public address or with the bridge's button."
    },
    {
      "id": "approver-list",
      "on": "bash",
      "pre": true,
      "re": "\\b(?:SUPERVISOR|FLOW)_APPROVERS=",
      "why": "changes who counts as an approver (a test setting of bin/supervisor and bin/flow): the bridge and the owner only."
    },
    {
      "id": "approved-label",
      "on": "bash",
      "pre": true,
      "re": "{{BD}}[^;&|\\n]*?(?:\\slabel\\s+(?:add|remove)\\s[^;&|\\n]*?|\\s--(?:add-label|remove-label|set-labels)(?:=|\\s+)['\"]?(?:[^\\s,'\"]+,\\s*)*|\\screate\\s[^;&|\\n]*?\\s(?:-l=?\\s*|--labels(?:=|\\s+))['\"]?(?:[^\\s,'\"]+,\\s*)*)(?<![\\w.:-])['\"]?approved(?![\\w.:-])|\\bxargs\\b[^;&|\\n]*{{BD}}[^;&|\\n]*?\\s(?:label\\s+(?:add|remove)|--(?:add-label|remove-label|set-labels)|create\\s[^;&|\\n]*?\\s(?:-l|--labels))\\b",
      "why": "sets or removes `approved`: that is the owner's T2 go, never an agent's. The owner gives it on the board's public address (signed in as the owner) or with the bridge's Approve button; ask for it on the item."
    },
    {
      "id": "approval-write",
      "on": "bash",
      "re": "{{WRITE}}[^;&|]*{{APPROVAL}}",
      "why": "changes the approval path (Claude settings and hooks, this guard, the bridge, mm's process definitions, the board's endpoints file, the approval ledger's verifier, the signer's config and folder): mm and the owner change it, never an agent."
    },
    {
      "id": "approval-base",
      "on": "bash",
      "re": "{{WRITE}}[^;&|]*{{APPROVAL_BASE}}|\\b(?:cd|pushd)\\s+\\S*\\bbin/?(?=[\\s;&|)]|$)[^\\n]*?{{WRITE}}[^;&|\\n]*(?:^|(?<=[\\s'\"=<>]))(?:guard|lib/(?:guard-rules|ledger)\\.mjs)(?![\\w.-])|\\b(?:cd|pushd)\\s+['\"]?\\S*/var/lib/mm-approve(?:/\\S*)?['\"]?(?=[\\s;&|)]|$)[^\\n]*?{{WRITE}}",
      "why": "changes a file of the approval path (a guard, the board's endpoints file, supervisor.json, the ledger's verifier, the signer's config, folder or ledger), named by its base name: mm and the owner change those, never an agent."
    },
    {
      "id": "ssh-write",
      "on": "bash",
      "re": "{{WRITE}}[^;&|]*\\.ssh(?:/|\\s|$)",
      "why": "changes SSH keys or access (~/.ssh): a lead never does; ask the owner on the board."
    },
    {
      "id": "ssh-file",
      "on": "file-write",
      "re": "/\\.ssh/",
      "why": "changes SSH keys or access (~/.ssh): a lead never does; ask the owner on the board."
    },
    {
      "id": "person-asks",
      "on": "bash",
      "re": "{{WRITE}}[^;&|]*(?:{{MMDIR}}/person-asks(?:/|(?![\\w.-]))|(?:^|(?<=[\\s'\"=<>]))(?:\\.\\./)*person-asks/)|\\b(?:cd|pushd)\\s+['\"]?\\S*person-asks/?['\"]?(?=[\\s;&|)]|$)[^\\n]*?{{WRITE}}",
      "why": "changes mm's record of person-run asks: wake starts a run on that person's own token from it (sy-2edw). Only mm (the gateway's Runs for you page, mm run-asks) changes it; reading it is fine."
    },
    {
      "id": "person-asks-file",
      "on": "file-write",
      "re": "{{MMDIR}}/person-asks(?:/|$)",
      "why": "mm's record of person-run asks: wake starts a run on that person's own token from it (sy-2edw). Only mm changes it."
    },
    {
      "id": "approval-file",
      "on": "file-write",
      "re": "{{APPROVAL}}",
      "why": "the approval path (Claude settings and hooks, this guard, the bridge, mm's process definitions, the board's endpoints file, the approval ledger's verifier, the signer's config and folder): mm and the owner change it, never an agent."
    }
  ]
}
// END RULES
