# memory/: what this project's agents learn

Facts and decisions about this project that should outlast one conversation: one file per fact, plus `MEMORY.md`,
the index every agent loads. The files live here, in the project's own config repo: versioned, backed up and restored
with the project. Each agent's Claude memory folder is a link to this folder (mm makes it when it starts the agent),
so a lead that saves a memory saves it here.

Each file starts with frontmatter:

```markdown
---
name: <short-kebab-case-slug>
description: <one line: what this is, used to decide whether it is relevant>
metadata:
  type: project | feedback | reference
  verified: 2026-01-01     # required: when it was last checked against reality
  ttl_days: 30             # required: after this many days without a check it is stale
---
<the fact; why it matters; how to apply it>
```

`config-check` refuses a file without `name`, `description`, `verified` (a date) and `ttl_days` (a number of days):
no defaults, because a default would claim someone checked the fact. `bin/health` keeps one item open for setup
that lists the memories past `verified + ttl_days`: check each again (new `verified`), fix it, or delete it.
Never put a secret here: memory is committed.
