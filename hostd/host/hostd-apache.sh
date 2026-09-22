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
#
# One move per line, from and to separated by a pipe, and read back a line at a time. The pathnames come
# from a directory an operator writes by hand, so one of them containing a space is not far-fetched, and
# a space is exactly what a whitespace-separated list of these would come apart on. Undoing a half-done
# adoption is not a thing to get wrong on a Tuesday because somebody named a file "old site.conf".
MOVED=""

restore() {
    [ -n "$MOVED" ] || return 0
    while IFS='|' read -r from to; do
        [ -n "$from" ] || continue
        mv "$to" "$from" 2>/dev/null || true
    done <<RESTORE
$MOVED
RESTORE
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
#
# Both loops read jq's output a line at a time rather than iterating an unquoted command substitution,
# which would split every path on whitespace. Every path here is agent-derived and so has none today,
# but this file is the one piece that cannot be tested, so it does not get to hold an assumption it
# cannot check. A here-document rather than a pipe: a piped while loop runs in a subshell, and MOVED
# would not survive it, which is what the trap above restores from.
STAGE="removing files"
while IFS= read -r path; do
    [ -n "$path" ] || continue
    rm -f "$path"
done <<REMOVE
$(jq -r '.remove[]?' "$REQUEST")
REMOVE

if [ "$ACTION" = "adopt" ]; then
    STAGE="disabling files"
    mkdir -p "$ADOPTED"
    while IFS= read -r path; do
        [ -n "$path" ] || continue
        target="$ADOPTED/$(basename "$path").bak"
        mv "$path" "$target"
        MOVED="$MOVED$path|$target
"
        # sites-enabled entries on Debian are relative symlinks a2ensite wrote, of the form
        # ../sites-available/<name>.conf, and a relative symlink only keeps resolving from wherever it
        # lands. "[ -e ]" follows symlinks, so it fails here exactly when the move broke one: the two
        # directories are not siblings, and "../sites-available" no longer means the same thing from
        # both. MOVED already carries this entry, appended just above, so the trap's restore() (which
        # runs on any failure from here on) puts it straight back without a second recovery path here.
        if [ ! -e "$target" ]; then
            STAGE="disabling $path: $target would be a broken symlink, because $(dirname "$path") and $ADOPTED are not sibling directories; a relative symlink only survives this move when both sit at the same depth"
            exit 1
        fi
    done <<DISABLE
$(jq -r '.disable[]?' "$REQUEST")
DISABLE
fi

# An adoption run backwards. The request names the original sites-enabled paths, the same ones the adopt
# named in its disable list, and this is the only place that knows where they were parked, which is why
# the agent never has to say.
#
# Nothing here is appended to MOVED, and that is deliberate rather than an oversight. MOVED exists so a
# half-done adoption can be undone, and undoing a half-done RESTORE means putting the operator's file
# back out of sites-enabled again, on a site that by this point has no hostd file either (the removals
# above ran first). That leaves the hostname with no vhost at all, which is the one outcome worse than a
# configuration Apache refused. So a restore that fails stops where it got to, with as much of the
# operator's own configuration back on disk as could be put back, and says so. Apache is still serving
# what it loaded last either way: nothing below this point has reloaded.
#
# A .bak that is not there is skipped rather than fatal. It means the file was already restored, by an
# earlier attempt or by the operator's own hand, and failing the whole request over it would leave the
# rest of the list un-restored for no gain.
if [ "$ACTION" = "restore" ]; then
    STAGE="restoring files"
    while IFS= read -r path; do
        [ -n "$path" ] || continue
        source="$ADOPTED/$(basename "$path").bak"
        [ -e "$source" ] || continue
        mv "$source" "$path"
    done <<RESTORE_LIST
$(jq -r '.restore[]?' "$REQUEST")
RESTORE_LIST
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
