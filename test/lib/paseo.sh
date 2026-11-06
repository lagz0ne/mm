# Sourced by every test that starts an agent or a lead in the machine's Paseo. Paseo keeps a project and a workspace
# for each folder an agent ran in, and mm archive takes only the agents: so a test, at its end, archives the workspaces
# it left and removes the Paseo projects rooted in its folders (a symlinked path too: pass both). Folders match by
# their text, as Paseo stored them; the test's folders are gone by then.
#   paseo_forget <dir>...   archive the workspaces in these folders, then remove the Paseo projects rooted there
#   paseo_left <dir>...     prints how many workspaces and projects are still there ("0 0": none)
_paseo_in() { case "$2" in ''|/) return 0 ;; esac; jq -r --arg f "$1" --arg d "$2" '.[] | select((.[$f] // "") as $p | $p == $d or ($p | startswith($d + "/"))) | (.workspaceId // .projectId)'; }
paseo_forget() {
  local d id
  for d in "$@"; do
    for id in $(paseo workspace ls --json 2>/dev/null | _paseo_in cwd "$d"); do paseo workspace archive "$id" >/dev/null 2>&1; done
    for id in $(paseo project ls --json 2>/dev/null | _paseo_in path "$d"); do paseo project delete "$id" >/dev/null 2>&1; done
  done
  return 0
}
paseo_left() {
  local d w=0 p=0
  for d in "$@"; do
    w=$((w + $(paseo workspace ls --json 2>/dev/null | _paseo_in cwd "$d" | wc -l)))
    p=$((p + $(paseo project ls --json 2>/dev/null | _paseo_in path "$d" | wc -l)))
  done
  echo "$w $p"
}
export -f _paseo_in paseo_forget paseo_left
