#!/bin/sh
# hostd's Apache rail. It is started by hostd-apache.path when the agent writes a request, and it does
# four things: perform the writes it was handed, run a configtest, reload Apache if the test passed, and
# write a result carrying the request's sequence number.
#
# It validates nothing. Every path and every byte in the request was validated by the agent, which is the
# process with the registry, the hostname rules and the template. Adding checks here would mean two
# places that must agree about what is legal, and this is the one that cannot be tested in CI.
set -eu

DIR="${HOSTD_APACHE_RAIL_DIR:-/etc/hostd/apache}"
REQUEST="$DIR/request.json"
RESULT="$DIR/result.json"
ADOPTED="${HOSTD_APACHE_ADOPTED_DIR:-/etc/apache2/hostd-adopted}"

[ -f "$REQUEST" ] || exit 0

SEQ=$(jq -r '.seq' "$REQUEST")
ACTION=$(jq -r '.action' "$REQUEST")

# Everything moved or written in this run, so a failed configtest can be undone completely. A disabled
# file is moved, never deleted: undoing an adoption has to be possible by hand, months later.
MOVED=""

restore() {
    for pair in $MOVED; do
        from=$(echo "$pair" | cut -d'|' -f1)
        to=$(echo "$pair" | cut -d'|' -f2)
        mv "$to" "$from" 2>/dev/null || true
    done
}

finish() {
    printf '{"seq":%s,"ok":%s,"output":%s}\n' "$SEQ" "$1" "$(printf '%s' "$2" | jq -Rs .)" > "$RESULT.tmp"
    mv "$RESULT.tmp" "$RESULT"
    rm -f "$REQUEST"
    exit 0
}

# Removals first, then the disables, then the write. All before the single configtest, which is what
# makes an adoption one reload rather than two.
for path in $(jq -r '.remove[]?' "$REQUEST"); do
    rm -f "$path"
done

if [ "$ACTION" = "adopt" ]; then
    mkdir -p "$ADOPTED"
    for path in $(jq -r '.disable[]?' "$REQUEST"); do
        target="$ADOPTED/$(basename "$path").bak"
        mv "$path" "$target"
        MOVED="$MOVED $path|$target"
    done
fi

if [ "$(jq -r '.write // "null"' "$REQUEST")" != "null" ]; then
    WRITE_PATH=$(jq -r '.write.path' "$REQUEST")
    jq -r '.write.text' "$REQUEST" > "$WRITE_PATH.tmp"
    mv "$WRITE_PATH.tmp" "$WRITE_PATH"
fi

if OUTPUT=$(apache2ctl configtest 2>&1); then
    if RELOAD=$(systemctl reload apache2 2>&1); then
        finish true "$OUTPUT"
    fi
    # The test passed and the reload did not, which is a machine problem rather than a configuration
    # one. Nothing is undone: the files are valid, and Apache is still serving the previous version.
    finish false "configtest passed but the reload failed: $RELOAD"
fi

# The configtest failed, so nothing has reloaded and Apache is still serving what it was. The disabled
# files go back immediately, because a site with no vhost at all is the one outcome worse than the one
# this was trying to replace. The file hostd wrote is left for the agent to revert, which is what knows
# what was there before.
restore
finish false "$OUTPUT"
