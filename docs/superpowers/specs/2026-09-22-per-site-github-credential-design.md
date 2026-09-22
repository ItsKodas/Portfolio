# Per-site GitHub credential design

Date: 2026-09-22
Status: approved design, not yet implemented
Extends: `docs/superpowers/specs/2026-09-20-hostd-provisioning-design.md` (the fetcher and the deploy
path it defines are live)

## Context

The fetcher is the only hostd process that holds a GitHub credential and the only one that reaches
GitHub. At boot it reads a single `GITHUB_TOKEN` from `hostd/.env.fetcher`, writes
`https://x-access-token:<token>@github.com` into `/root/.git-credentials`, and points git's global
`credential.helper` at that file. `url.https://github.com/.insteadOf git@github.com:` then means a
registry entry can name an ssh-style repo and still be fetched over HTTPS with that token. The agent
asks the fetcher to run git over a Unix socket (`clone`, `fetch`, `checkout`, `log`, `tip`, `branches`);
api never sees the credential at all.

One token means one GitHub account. Some client sites live under repositories on other accounts, which
that token cannot read, so those sites cannot be cloned, cannot be polled for new commits, and show an
empty branch dropdown on the Settings tab.

## Scope

### In scope

- A second and further GitHub tokens, supplied to the fetcher through `hostd/.env.fetcher`
- A per-project registry key naming which of them a project uses
- Choosing that name on the portal's Settings tab, from a list the fetcher itself answers with
- The fetcher selecting the right credential per git invocation, for the three verbs that reach GitHub
- Runbook steps for adding an account, and a troubleshooting entry

### Not in scope

- Entering a token value through the portal. Token values are added to `.env.fetcher` on the dedi by
  hand, as `GITHUB_TOKEN` already is. Nothing in api, the agent or the portal ever holds a token.
- Per-environment credentials. `repo` is a project-level key and both environments fetch the same
  repository, so the credential is project level too.
- Hosts other than GitHub. The credential line and the `insteadOf` rewrite both name github.com.
- Rotating, validating or expiring tokens.

## Decisions

Each was made explicitly with the operator.

**The registry holds a name, never a value.** A project gains an optional `credential:` key beside
`repo`. The key is called `credential` rather than `token` deliberately: a key called `token` invites
someone to paste a real PAT into a YAML file that every process reads and the portal renders on screen.
Names match `^[a-z0-9_]{1,32}$` and map to `GITHUB_TOKEN_<NAME uppercased>` in the fetcher's env. Absent
means today's default `GITHUB_TOKEN`, so every existing project keeps working untouched.

**Secrets stay inside the fetcher.** The name travels portal to api to agent to fetcher; the value never
leaves the container that reads it from the env at boot. This preserves the invariant the fetcher exists
for: the process with the Docker socket has no credential, and the process with the credential has no
Docker socket.

**One credential file per token, chosen per git invocation.** At boot the fetcher writes
`/root/.git-credentials.<name>` at 0600 for each named token, alongside today's default file. A request
naming a credential runs git with:

```
-c credential.helper= -c credential.helper=store --file=/root/.git-credentials.<name>
```

The empty first value is load-bearing. Git reads `credential.helper` as a list and tries the entries in
config order, with command-line `-c` entries last, so without the reset the global helper set at boot
would answer first and the default token would be used with no error to notice. A wrong-account fetch
that silently succeeds against a public repo, or silently fails against a private one, is exactly the
failure this key is meant to remove.

The alternative considered was one credential file with several lines and `credential.useHttpPath=true`,
letting git match by repository path. Rejected: the stored path has to match what git asks for exactly,
including the `.git` suffix that `insteadOf` leaves on a rewritten ssh URL, a miss falls through to the
default line silently, and every git run can still reach every token.

**A malformed token name in the env is fatal at boot.** The fetcher already refuses to start without
`GITHUB_TOKEN`. A `GITHUB_TOKEN_Acme-1=` that was skipped quietly would surface days later as a deploy
that cannot read a repository, so it fails the same way instead, naming the variable.

**The name is validated where it is set, not only where it is used.** `configure` asks the fetcher for
its list before writing, so the registry can never hold a name that cannot work.

**Only the three verbs that reach GitHub carry a credential.** `clone`, `fetch` and `branches` talk to
the remote. `checkout`, `log` and `tip` read local refs and stay exactly as they are.

## Design

### Registry

```yaml
projects:
  acme:
    repo: git@github.com:acme/site.git
    credential: acme      # optional; absent means the default GITHUB_TOKEN
```

- `registry.ts`: `credential` joins `PROJECT_KEYS`, a `CREDENTIAL_NAME` regex is added beside
  `GIT_REPO`, and `ProjectEntry` gains `credential: string | null`. A malformed value invalidates that
  project only, with the message `credential must be lowercase letters, digits or underscore, 1 to 32
  characters`.
- `registry-write.ts`: the `configure` change gains `credential?: string | null`. Absent leaves the key
  alone, a name sets it, null deletes it, matching how `repo` already behaves. `ProjectDraft` gains the
  same optional field, so a project created with a credential is written with one.

### Fetcher

- `credentials.ts` keeps `credentialLine` and gains:
  - `readCredentials(env)`, returning the default token and a `Map<string, string>` of named tokens,
    plus the list of problems that make boot fatal.
  - `credentialFile(name)`, the path for a name.
  - `credentialArgs(name | null)`, returning the reset-plus-store pair above, or `[]` for the default.
- `index.ts`: `writeCredentials` writes the default file and the global helper as it does today, plus
  one 0600 file per named token. Boot failures join the existing `failures` list.
- `git.ts`: `runGit` takes the credential names as a third argument. It prepends `credentialArgs` beside
  the existing `safeDirectoryArgs`, refuses an unknown name with `bad-request: unknown credential
  <name>`, and answers the new `credentials` verb from that list without running git at all. `redact`
  needs no change: it already strips URL userinfo and both PAT prefixes.

### Protocols

- `fetch-protocol.ts`: `clone`, `fetch` and `branches` gain an optional `credential` field, validated
  against the name regex and included in each verb's `onlyKeys` guard. A new `{ verb: 'credentials' }`
  request answers `{ ok: true, credentials: string[] }`, names only, sorted.
- `protocol.ts`: `ConfigureArgs` gains `credential?: string | null` and `ProvisionCreateArgs` an optional
  `credential`, both parsed and refused the way `repo` is. A new project-less `credentials` verb and its
  reply type are added.

### Agent

- `agent.ts` passes `project.credential` on its `clone`, `fetch` and `branches` calls, proxies the new
  `credentials` verb to the fetcher, and validates a non-null `credential` in `configure` against that
  list before writing, refusing `bad-request: no credential named <name>`.
- The other two call sites that reach GitHub pass a credential too. `deploy.ts`'s `currentTip` takes it
  from the project entry it is already given. This is the part most easily missed: a project that clones
  with the right token and then polls with the wrong one would look provisioned and never deploy again.
- `provision.ts` clones in two places. `addEnvironment` reads the credential from the existing project
  entry. `createProject` has no entry yet, so `ProvisionCreateArgs` gains an optional `credential`, which
  is passed to the clone and written into the new registry entry by `registry-write.ts`'s `ProjectDraft`.
  Without it, a site on a second account could not be created through hostd at all, only enrolled by hand
  and then pointed at its credential afterwards.
- `log`, `tip` and `checkout` read local refs and carry nothing.

### api

`GET /credentials`, machine level, admin only. It is gated by `caller.actor.kind !== 'admin'` the way
`audit-all` is, not through `authorize`, because there is no project in the question. `configure` passes
the new field through `parseConfigureArgs` unchanged in shape. The project listing carries `credential`
beside `repo`, under the same admin-only condition and for the same reason: it is a fact about the
machine, and a client has no use for it. That is how the Settings form learns the saved name.

### Portal

- `server/hostd/credentials.ts` mirrors `branches.ts`.
- The site page fetches the list beside the branch list and passes `credentials` and `credentialsError`
  into the Settings form, tolerating an unreachable hostd the same way `branchesError` already does.
- `settings.tsx` gains an Account select: `default (GITHUB_TOKEN)` plus one option per name. It follows
  the two rules the branch field learned from a live incident: only changed fields go into the payload,
  and a saved name the fetcher no longer lists is still shown rather than replaced by whichever option
  happens to be first.
- `actions.ts`'s `saveSettingsAction` payload gains `credential`.

### Documentation

`hostd/RUNBOOK.md` gains the steps for adding an account (create the fine-grained token, add
`GITHUB_TOKEN_<NAME>` to `.env.fetcher`, restart the fetcher, pick the name on Settings) and a
troubleshooting row for `unknown credential <name>`. `example.env.fetcher` gains a commented example of
a second token.

## Error handling

| Case | Behaviour |
| --- | --- |
| `GITHUB_TOKEN_<bad name>` or an empty value in `.env.fetcher` | The fetcher refuses to boot, naming the variable |
| A name set on a project the fetcher does not have | Refused at save, with `no credential named <name>` |
| A name that disappears from `.env.fetcher` afterwards | The next clone, fetch or branch listing refuses with `unknown credential <name>`; the Settings select still shows the saved name |
| Token revoked or lacking access | git fails as it does today, with GitHub's own message, redacted |
| Fetcher unreachable | The Account select is disabled and hostd's own words are shown, as `branchesError` does |

## Testing

Test-driven, with tests beside each file as the project does throughout.

- `fetcher/credentials.test.ts`: env scan, name grammar, fatal cases, the args shape including the empty
  reset entry, and the 0600 mode. The reset entry gets a test of its own because dropping it is the one
  regression here that produces no error at all.
- `fetcher/git.test.ts`: argv per verb with and without a credential, unknown-name refusal, and the
  `credentials` verb answering names without running git.
- `shared/fetch-protocol.test.ts` and `shared/protocol.test.ts`: the new field accepted and refused, the
  new verb, and the `onlyKeys` guards.
- `shared/registry.test.ts` and `shared/registry-write.test.ts`: parsing, the invalid message, and
  setting, changing and deleting the key without disturbing the operator's comments.
- `agent/agent.test.ts`: the name reaching each of the three verbs, and `configure` refusing an unknown
  one.
- `api/routes.test.ts`: 403 for a non-admin, and the 200 shape.
- `settings.test.tsx`: the select renders, only changed fields are sent, and a saved name missing from
  the list is still displayed.

## Open questions

None.
