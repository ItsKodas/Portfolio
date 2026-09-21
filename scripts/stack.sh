#!/bin/sh
# One command for the three stacks this box runs: hostd, mail and the site. They stay three separate
# compose projects, because merging them into one would mean a single `down` could take mail offline by
# accident, one flat namespace for three sets of secrets, and a rename of every named volume. All this
# script does is run them in the right order, with the right flags, and refuse the dangerous ones.
#
# Order is the substance of it. The site joins hostd's network with `external: true`, so hostd has to be
# up before the site, and the site has to be down before hostd (Docker will not remove a network that
# still has containers attached).
#
#   ./scripts/stack.sh up [flags] [stack]
#   ./scripts/stack.sh down [flags] [stack]
#
# --dry-run prints what it would run, in order, and runs nothing.

set -eu

# Resolved from the script's own location, not the caller's, so the repo root is the expected place to
# run this from without being the only one that works.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/.." && pwd)

die() {
    echo "stack.sh: $*" >&2
    exit 1
}

dir_of() {
    case "$1" in
        hostd) echo "$root/hostd" ;;
        mail) echo "$root/mail" ;;
        site) echo "$root" ;;
    esac
}

dry=no
assume_yes=no
verb=
stack=
# The argv compose actually receives, and the same list with --pull's value dropped. Two variables
# because the allowlist check below has to look at flag names only, and `always` is not a flag.
flags=
flag_names=

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)
            dry=yes
            ;;
        -y|--yes)
            assume_yes=yes
            ;;
        --pull)
            shift
            [ $# -gt 0 ] || die "--pull needs a policy: always, missing, never or build"
            case "$1" in
                always|missing|never|build) ;;
                *) die "--pull does not take $1; it takes always, missing, never or build" ;;
            esac
            flags="$flags --pull $1"
            flag_names="$flag_names --pull"
            ;;
        -*)
            flags="$flags $1"
            flag_names="$flag_names $1"
            ;;
        *)
            if [ -z "$verb" ]; then
                verb="$1"
            elif [ -z "$stack" ]; then
                stack="$1"
            else
                die "$1 is one word too many; it takes a verb and at most one stack"
            fi
            ;;
    esac
    shift
done

# An allowlist rather than a pass-through, so -v, --volumes and --rmi have no route through this script
# at all. mail-data, db-data and hostd-state are named volumes: nothing typed at this may reach them.
case "$verb" in
    up) allowed="--build --force-recreate --no-deps --remove-orphans --pull" ;;
    down) allowed="--remove-orphans" ;;
    "") die "nothing to do; it takes up or down" ;;
    *) die "$verb is not something this script does; it does up and down" ;;
esac

for name in $flag_names; do
    case " $allowed " in
        *" $name "*) ;;
        *) die "$verb does not take $name; it takes $allowed" ;;
    esac
done

case "${stack:-all}" in
    all|hostd|mail|site) ;;
    *) die "$stack is not a stack this script knows; it knows hostd, mail and site" ;;
esac

if [ -n "$stack" ]; then
    order="$stack"
elif [ "$verb" = up ]; then
    order="hostd mail site"
else
    order="site mail hostd"
fi

# Only worth checking when the site is going up without hostd going up beside it: in a full run hostd has
# already been and gone by the time the site starts.
guard=no
if [ "$verb" = up ]; then
    case " $order " in
        *" site "*)
            case " $order " in
                *" hostd "*) ;;
                *) guard=yes ;;
            esac
            ;;
    esac
fi

if [ "$verb" = down ] && [ "$dry" = no ] && [ "$assume_yes" = no ]; then
    if [ ! -t 0 ]; then
        die "down needs confirming and nothing here can answer; pass -y to run it unattended"
    fi
    printf 'Take %s down? [y/N] ' "$(echo "$order" | tr ' ' ',')"
    read -r answer
    case "$answer" in
        y|Y|yes|Yes) ;;
        *) die "left alone" ;;
    esac
fi

guard_site() {
    if [ "$dry" = yes ]; then
        echo "[site] guard: docker network inspect hostd"
        return 0
    fi
    docker network inspect hostd >/dev/null 2>&1 \
        || die "the hostd network does not exist, so the site cannot join it; bring hostd up first"
}

run_stack() {
    if [ "$verb" = up ]; then
        argv="up -d$flags"
    else
        argv="down$flags"
    fi
    if [ "$dry" = yes ]; then
        echo "[$1] docker compose $argv"
        return 0
    fi
    echo "[$1] docker compose $argv"
    # Unquoted on purpose: every word in it came from the allowlist above, never from a caller's string.
    ( cd "$(dir_of "$1")" && docker compose $argv )
}

# Up stops at the first failure: with hostd not up, the site's own start would only fail again on the
# missing network, with a worse message. Down does not, because a stack that is already down must not be
# able to strand the two behind it.
failed=
for name in $order; do
    if [ "$verb" = up ]; then
        if [ "$name" = site ] && [ "$guard" = yes ]; then
            guard_site
        fi
        run_stack "$name"
    else
        if ! run_stack "$name"; then
            failed="$failed $name"
        fi
    fi
done

[ -z "$failed" ] || die "these did not come down cleanly:$failed"
