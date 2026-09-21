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

# STAGE names roughly where the script is, so a crash the trap below catches can say more than "it
# failed". SEQ starts empty on purpose: if it is never read (jq missing, the request will not parse), the
# trap has to know that no correct result can be written, rather than printing an empty seq into one.
# DONE marks that finish() has already run, so the trap does not act a second time after a normal exit.
STAGE="reading the request"
SEQ=""
DONE=""

# Everything moved in this run, so a failed configtest, or anything else going wrong, can be undone
# completely. A disabled file is moved, never deleted: undoing an adoption has to be possible by hand,
# months later.
MOVED=""

restore() {
    for pair in $MOVED; do
        from=$(echo "$pair" | cut -d'|' -f1)
        to=$(echo "$pair" | cut -d'|' -f2)
        mv "$to" "$from" 2>/dev/null || true
    done
}

finish() {
    DONE=1
    if [ -n "$SEQ" ]; then
        printf '{"seq":%s,"ok":%s,"output":%s}\n' "$SEQ" "$1" "$(printf '%s' "$2" | jq -Rs .)" > "$RESULT.tmp"
        mv "$RESULT.tmp" "$RESULT"
    else
        # No seq was ever read, so there is no request this could correctly be an answer to: writing one
        # would just be a result nothing will ever match. Say what happened where it will still be seen.
        echo "hostd-apache: $2" >&2
    fi
    rm -f "$REQUEST"
    exit 0
}

# The handshake has to complete whatever happens past this point. hostd-apache.path only fires on
# request.json going from absent to present (PathExists, not PathChanged), so a request this script exits
# on without answering, for any reason, leaves the rail wedged: no later domain change can ever run again
# until a human notices and clears the file by hand. That is worse than the 30 second timeout
# apache-rail.ts already expects and tolerates, because a late answer is still safe (the sequence number
# makes it so) and a request that can never be answered at all is not.
#
# So: on any exit that finish() has not already handled, restore whatever was moved aside (a failure
# halfway through disabling several files must not leave a client's site with no vhost serving at all,
# any more than a failed configtest may) and write the best answer that can honestly be given, then clear
# the request so the path unit re-arms for the next one regardless.
trap '
    status=$?
    if [ -z "$DONE" ]; then
        restore
        finish false "the rail failed while $STAGE (exit $status); see journalctl -u hostd-apache.service"
    fi
' EXIT

SEQ=$(jq -r '.seq' "$REQUEST")
ACTION=$(jq -r '.action' "$REQUEST")

# Removals first, then the disables, then the write. All before the single configtest, which is what
# makes an adoption one reload rather than two.
STAGE="removing files"
for path in $(jq -r '.remove[]?' "$REQUEST"); do
    rm -f "$path"
done

if [ "$ACTION" = "adopt" ]; then
    STAGE="disabling files"
    mkdir -p "$ADOPTED"
    for path in $(jq -r '.disable[]?' "$REQUEST"); do
        target="$ADOPTED/$(basename "$path").bak"
        mv "$path" "$target"
        MOVED="$MOVED $path|$target"
    done
fi

if [ "$(jq -r '.write // "null"' "$REQUEST")" != "null" ]; then
    STAGE="writing the new file"
    WRITE_PATH=$(jq -r '.write.path' "$REQUEST")
    jq -r '.write.text' "$REQUEST" > "$WRITE_PATH.tmp"
    mv "$WRITE_PATH.tmp" "$WRITE_PATH"
fi

STAGE="running configtest"
if OUTPUT=$(apache2ctl configtest 2>&1); then
    STAGE="reloading Apache"
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
