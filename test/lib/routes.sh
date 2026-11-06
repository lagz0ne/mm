# Sourced by every test that brings a project up on this machine (review sy-uzh). mm writes this run's routes only into
# the run's own folder (test/lib/expose), never into the live web proxy's. live_routes_same: true when the live route
# folder (the machine's `expose` names it) is as it was when the test began. Nothing here reads a route's content.
export MM_EXPOSE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/expose"
export MM_EXPOSE_DIR; MM_EXPOSE_DIR=$(mktemp -d /tmp/mm-expose.XXXXXX)
LIVE_ROUTES_DIR=$(sed -n 's/^DIR=//p' "$(command -v expose 2>/dev/null || echo /dev/null)" 2>/dev/null | head -1)
live_routes() { [ -n "$LIVE_ROUTES_DIR" ] && ls -l --time-style=+%s "$LIVE_ROUTES_DIR" 2>/dev/null | md5sum; }
LIVE_ROUTES_BEFORE=$(live_routes)
live_routes_same() { [ -z "$LIVE_ROUTES_DIR" ] || [ "$(live_routes)" = "$LIVE_ROUTES_BEFORE" ]; }
export LIVE_ROUTES_DIR LIVE_ROUTES_BEFORE; export -f live_routes live_routes_same
