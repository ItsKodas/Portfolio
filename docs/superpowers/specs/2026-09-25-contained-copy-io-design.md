# Contained file I/O for copies and backups (proposal)

Status: agreed 2026-09-25 and built in hostd/src/agent/io-helper.ts. Follow-up 3 from PR #128. Where
the build differs from the proposal below, "As built" at the end says how.

## The gap

copy-run.ts and backup-run.ts resolve a path (realpath, lstat), check it stays inside the right folder,
and then hand the path to sqlite3, cp or rename. The kernel walks the path again at that moment. A
client container bind-mounts its own checkout (`/var/www/<site>/live` or `/var/www/<site>/<env>`)
read-write, so between the check and the use it can swap a folder inside that checkout for a symlink to
`/var/www/<other site>/...`. The agent runs as root with all of `/var/www` mounted, so the read (or the
write) then follows the link into another site. The window is small but a client controls its timing.

What a client container cannot change: the site folder `/var/www/<site>` itself and its `.copy` staging
(0700, root), since no client container mounts them. That is what the design leans on.

## Proposal

Do each read or write of client-controlled paths inside a short-lived helper container whose mount table
holds only what that step may touch. A symlink that points anywhere else then resolves inside the
helper's own filesystem, where `/var/www/<other site>` does not exist, and `..` out of a mount's root
stays at the mount's root. The check is enforced by the kernel's view, not by a prior lookup.

The helper follows host-ports.ts: the agent's own image by id (sqlite3 and busybox cp are already in
it; nothing is pulled), `docker run --rm --name hostd-io-<run>`, `--network none`, `--read-only`,
`--security-opt no-new-privileges`, `--pull never`, `--cap-drop ALL` plus only `CHOWN`, `DAC_OVERRIDE`,
`FOWNER` and `FSETID` (what `cp -a` needs to keep live's owners and modes), and `docker rm -f` by name if
the run times out.

Mounts per step (paths are host paths; the agent mounts `/var/www` at the same path, so they match):

| Step | Mounts |
| --- | --- |
| copy, storage read | live's folder at `/live:ro`, the run's staging at `/stage` |
| copy, sqlite read | the folder holding live's resolved database at `/db` (read-write, see below), staging at `/stage` |
| copy, move into the environment | the site folder at `/site`, with live's folder over-mounted read-only at `/site/live` |
| backup, sqlite read | as the copy's sqlite read, with backup staging at `/stage` |
| backup, generic bind mount copy | the bind mount's source at `/src:ro`, staging at `/stage` |

Notes on the choices:

- **sqlite needs write access beside the database.** A reader of a WAL database writes `-shm`, and a hot
  rollback journal has to be rolled back, so a read-only mount makes `.backup` fail on exactly the
  databases that are in use. Mounting only the database's own folder read-write keeps sqlite3's locking
  as it is today while confining it to that folder. The side-file symlink check from follow-up 1 stays as
  a clearer early error.
- **Moves need one mount.** rename across two bind mounts fails with EXDEV even on one filesystem, so
  the step that moves staging into the environment mounts the whole site folder (not client-writable)
  and masks live with a read-only over-mount. Other environments of the same site stay visible; they are
  the same client's, and `confine` still refuses them before the move.
- **Mount sources are still resolved by dockerd** at container create. That is safe because each source
  is a folder no client container can change (a site folder, live's folder itself, staging), or is the
  resolved database folder, which is re-checked by comparing the helper's `stat` of `/db` against the
  agent's (device and inode) before sqlite3 runs.
- The existing realpath and lstat checks stay: they give the clear reasons the portal shows, and they are
  no longer the only thing between a client and another site.

## Cost and risk

- A container start per step: roughly half a second, against copies that take minutes. Backups run one
  helper per sqlite database or generic mount.
- New failure mode: the agent's image id cannot be read. host-ports.ts already handles this and the same
  lookup is reused.
- Tests: the runner fake records the `docker run` argv, so each step's mounts, caps and flags are asserted
  directly, as probeArgv is today. One real-docker check on the dedi before merging.

## Out of scope

- **restic** reads storage paths in the agent. Running it in a helper changes the paths recorded in
  every snapshot, which the file API and restores rely on. It is a separate change if wanted.
- Dumps over `docker exec` stream into staging the agent owns, and never touch a client path.

## As built

- **Mounted at their own paths.** Live's folder (for `cp -a`) and the site folder with live over it (for
  renames and new folders) are mounted at their host paths, not `/live` and `/site`. A symlink live has
  always had inside itself, absolute or relative, then resolves as it does on the host; other sites are
  still not in the helper. `/db`, `/src` and `/stage` stay as proposed, since those are resolved paths.
- **One helper per rename or new folder**, not one per step, so the copy's existing rollback of partial
  moves stays in TypeScript. A rename is node's `renameSync`, a new folder `mkdirSync` then `lchownSync`
  and `chmodSync`, run with the image's own node.
- **Host paths come from the agent's own mounts.** `docker inspect` reads the agent's image and bind
  mounts once. Each mount source is translated through the deepest bind mount holding it: `/backups` is
  the host's backup disk under another name. A path under no bind mount is refused before anything runs.
- **A generic bind mount** in the site is mounted at the folder it resolved to and checked by device and
  inode like the sqlite folder. One outside `/var/www` is mounted as the host path compose named, unchecked,
  as the agent cannot see it. The copy is now `cp -a` rather than node's `cp`, so owners are kept.
- Exit code 97 (`FOLDER_CHANGED`) from the helper means the folder it mounted is not the one the agent
  resolved.
