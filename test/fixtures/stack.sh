#!/bin/sh
# A stack script for the tests. It runs nothing: it records each call in the workspace, and the
# environment it was given in the slot's own directory.
b() { if [ -n "$1" ]; then basename "$1"; else echo -; fi; }
printf '%s %s %s web=%s api=%s\n' "$1" "$FACTORY_STACK" "$FACTORY_SLOT" \
  "$(b "$FACTORY_WORKTREE_WEB")" "$(b "${FACTORY_WORKTREE_API:-}")" >> "$FACTORY_WORKSPACE/calls.log"
env | grep '^FACTORY_' | sort > "$FACTORY_SLOT_DIR/env.$1"
case $1 in
  up|down|destroy) [ -d "$FACTORY_LOG_DIR" ] || { echo "no log dir" >&2; exit 9; } ;;
  url) echo "http://$FACTORY_STACK-$FACTORY_SLOT.test" ;;
  status)
    printf 'web\thttp://web.%s-%s.test\thttp://web.%s-%s.test/up\n' "$FACTORY_STACK" "$FACTORY_SLOT" "$FACTORY_STACK" "$FACTORY_SLOT"
    [ -z "${FACTORY_WORKTREE_API+x}" ] || printf 'api\thttp://api.%s-%s.test\n' "$FACTORY_STACK" "$FACTORY_SLOT" ;;
  doctor)
    echo "ok container runtime"
    [ "$FACTORY_SLOT" != 2 ] || echo "MISSING web.$FACTORY_STACK-2.test resolving [fix: add it to /etc/hosts]" ;;
  *) echo "unknown verb $1" >&2; exit 2 ;;
esac
