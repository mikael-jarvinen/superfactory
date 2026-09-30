#!/bin/sh
# The stack script for stacks.app in examples/factory.toml, called as `app.sh <verb>`. The contract
# is in the program's docs/design.md. Each repo gets a trivial server on a port derived from the
# slot; replace it with the repo's own dev server, run from its worktree.
set -eu

web_port=$((4000 + FACTORY_SLOT * 10))
api_port=$((web_port + 1))

# serve <repo> <port> <worktree>: start the repo's server in the background, then wait for it.
serve() {
  [ -d "$3" ] || { echo "no $1 worktree in $FACTORY_STACK slot $FACTORY_SLOT" >&2; exit 1; }
  factory stack run-detached --pid-file "$FACTORY_SLOT_DIR/$1.pid" --log "$FACTORY_LOG_DIR/$1.log" \
    --cwd "$3" --port "$2" -- \
    node -e "require('http').createServer((q, s) => s.end(process.cwd() + '\n')).listen($2, '127.0.0.1')"
  factory stack wait-http "http://127.0.0.1:$2/" --timeout 30
}

stop() {
  factory stack run-detached --stop --pid-file "$FACTORY_SLOT_DIR/$1.pid" --port "$2"
}

case "${1:-}" in
  up)
    serve web "$web_port" "$FACTORY_WORKTREE_WEB"
    serve api "$api_port" "$FACTORY_WORKTREE_API"
    ;;
  down)
    stop web "$web_port"
    stop api "$api_port"
    ;;
  destroy)
    # Must work after the worktrees are gone. A real stack drops its database here too.
    stop web "$web_port"
    stop api "$api_port"
    rm -rf "${FACTORY_SLOT_DIR:?}"/*
    ;;
  url)
    echo "http://127.0.0.1:$web_port/"
    ;;
  status)
    # name, url, and the url the board probes for health
    printf 'web\thttp://127.0.0.1:%s/\thttp://127.0.0.1:%s/\n' "$web_port" "$web_port"
    printf 'api\thttp://127.0.0.1:%s/\thttp://127.0.0.1:%s/\n' "$api_port" "$api_port"
    ;;
  doctor)
    for tool in node factory; do
      if command -v "$tool" >/dev/null 2>&1; then echo "ok $tool on PATH"
      else echo "MISSING $tool on PATH [fix: install it, or put it on the PATH the fleet runs with]"; fi
    done
    ;;
  *)
    echo "usage: app.sh up|down|destroy|url|status|doctor" >&2
    exit 2
    ;;
esac
