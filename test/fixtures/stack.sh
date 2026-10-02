#!/bin/sh
# A stack script for the tests. It runs nothing: it records each call in the workspace, and the
# environment it was given in the slot's own directory.
b() { if [ -n "$1" ]; then basename "$1"; else echo -; fi; }
verb=$1; shift
args=""; for a in "$@"; do args="$args|$a"; done
printf '%s %s %s web=%s api=%s%s\n' "$verb" "$FACTORY_STACK" "$FACTORY_SLOT" \
  "$(b "$FACTORY_WORKTREE_WEB")" "$(b "${FACTORY_WORKTREE_API:-}")" "${args:+ args=${args#|}}" >> "$FACTORY_WORKSPACE/calls.log"
env | grep '^FACTORY_' | sort > "$FACTORY_SLOT_DIR/env.$verb"
case $verb in
  up|down|destroy) [ -d "$FACTORY_LOG_DIR" ] || { echo "no log dir" >&2; exit 9; } ;;
  url) echo "http://$FACTORY_STACK-$FACTORY_SLOT.test" ;;
  status)
    # a test that probes the slot writes the health url its sites should answer on
    h=$(cat "$FACTORY_SLOT_DIR/health" 2>/dev/null || true)
    printf 'web\thttp://web.%s-%s.test\t%s\n' "$FACTORY_STACK" "$FACTORY_SLOT" "${h:-http://web.$FACTORY_STACK-$FACTORY_SLOT.test/up}"
    [ -z "${FACTORY_WORKTREE_API+x}" ] || printf 'api\thttp://api.%s-%s.test\t%s\n' "$FACTORY_STACK" "$FACTORY_SLOT" "$h" ;;
  doctor)
    echo "ok container runtime"
    [ "$FACTORY_SLOT" != 2 ] || echo "MISSING web.$FACTORY_STACK-2.test resolving [fix: add it to /etc/hosts]" ;;
  *) echo "unknown verb $verb" >&2; exit 2 ;;
esac
