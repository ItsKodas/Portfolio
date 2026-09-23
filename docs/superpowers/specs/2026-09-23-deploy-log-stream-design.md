# Watching a deploy: live output in the portal

**Date:** 2026-09-23
**Status:** approved

## The problem

A deploy takes about thirty seconds and says nothing while it runs. The portal shows *Asked for:
Deploying. It builds first and swaps over after, which usually takes a minute or two*, and then a row
appears in the history once it is over. If it failed, the reason is one line and the output is behind a
`Show what it printed` disclosure.

Nothing anywhere emits a line while a deploy is happening. `runCompose` in `agent/deploy-compose.ts`
awaits the whole of `docker compose build` and returns `tail()` of the combined streams, so the output
does not exist until the command has finished, and it is truncated to the last `OUTPUT_TAIL_BYTES` when
it does. Six deploy failures in two days were each diagnosed by reading a single stored line after the
fact; several of them would have been obvious from watching.

The deploy already narrates itself. `runDeploy` calls `deps.log` at every phase (`building`, `carried
docker-compose.override.yml into the new tree`, `rolled back, ...`). Those lines go to the agent's
stdout and nowhere a portal can reach.

## Scope

In scope: a live stream of one environment's deploy activity, from the agent through api to the portal,
and a column on the Deploys tab that shows it.

Out of scope: changing what a deploy does, changing `record.output` or the history, streaming lifecycle
or backup output, and any change to the container log view.

## What the operator sees

The Deploys tab gains a column on the right, always present, stacking under the content below roughly
900px. While a deploy runs it fills line by line: the deploy's own phase lines, with `docker compose`
output beneath the build step. When the deploy ends the column keeps showing what it printed until the
next deploy starts, so the output of the thing that just failed is on screen rather than behind a
disclosure.

The column is present whether or not a deploy is running, which is the point: a column that appeared
during a deploy would reflow the page twice each time, once at the start and once at the end, with the
history moving under the operator's cursor both times.

A deploy the poller started is watchable exactly like one the operator pressed, and a reload mid-deploy
picks up where it was. Neither is a special case: both are a new subscriber attaching to a buffer.

## The event

```ts
type DeployEvent = { at: string, startedAt: string, kind: 'step' | 'output' | 'end', text: string }
```

`step` is the deploy narrating itself, `output` is a line `docker compose` printed, `end` is the last
event of a deploy and its `text` is the outcome, the reason when there is one, and the duration, so a
watcher knows it is over and how it went without polling the history. `startedAt` identifies the deploy,
and is what lets one stream carry a sequence of them.

## The agent

### The runner gains an optional line sink

```ts
export type Runner = (command, args, timeoutMs, onLine?: (line: string) => void) => Promise<RunResult>
```

Additive, so every existing caller is untouched. `createSpawnRunner` already holds each chunk for its
`Capture`; it also hands each completed line onward. `RunResult` does not change, so `record.output`
stays exactly what it is today. `restic.ts`'s `nodeSpawnStream` is the existing precedent for streaming a
child's stdout in this codebase.

**The sink takes both streams, not just stderr.** The spike found compose v5.1.3 writing its build
progress to **stdout** and only the closing `Image <name> Built` summary to stderr. `deploy-compose.ts`
currently carries the comment "Compose writes its progress to stderr, so both streams are the output",
which is either out of date or version dependent; it is right to join both either way, and the line sink
must do the same rather than trusting that comment and listening to one.

### The narrative needs no change to `runDeploy`

`DeployRunner.run` already builds the deps it hands to a deploy. It wraps two of them per deploy:

```ts
log: line => { this.deps.log(line); watch.step(line) },
runner: (cmd, args, ms, onLine) => this.deps.runner(cmd, args, ms, line => { watch.output(line); onLine?.(line) }),
```

Every `deps.log` call inside a deploy is already a phase line, so the narrative comes out of code that
exists. Within a deploy the runner is only ever reached through `runCompose`, so the wrap has exactly one
producer.

### The buffer

One bounded ring per environment, held by `DeployRunner` beside the `running` map it already keeps.
Bounded by bytes, under its own constant rather than reusing `OUTPUT_TAIL_BYTES`: that one bounds the
tail of one command stored in a record, while this bounds a whole deploy's narrative and output held in
memory, so they are different numbers for different reasons and should not drift together. The bound
exists for the same reason though: a chatty build must cost a fixed amount, because most deploys are
started by the poller with nobody watching.

A subscriber attaching gets the buffer replayed, then live events. The buffer is kept after the deploy
ends and dropped when the next deploy for that environment starts, so the cost is one buffer per
environment rather than one per deploy ever run.

### One new verb

```ts
{ verb: 'deploy-watch', project, args: { environment } }  ->  { kind: 'stream', ... }
```

Its own verb rather than a `deploy` action, because every action in `parseDeployArgs` returns an
`AgentReply` and a stream is a different `Outcome` kind. `logs` already sets the precedent that a stream
gets its own verb. Overloading `deploy` would make one verb return two shapes depending on a string.

`Outcome`'s stream widens to `AsyncIterable<LogLine | DeployEvent>`. `LogLine` is shaped for container
logs and its `stream: 'stdout' | 'stderr'` means nothing for a phase line. `server.ts` writes one JSON
object per line and does not care which, so this costs an honest type and nothing else.

## The route

`/projects/<id>/<env>/deploy` is `only('POST', ...)` today. It becomes a method switch:

```
POST /projects/<id>/<env>/deploy    start one      (unchanged)
GET  /projects/<id>/<env>/deploy    watch one      (new)
```

No new path segment, and the pairing reads correctly. Gated by the `deploy` capability and readable by
the owner, following `routes.ts`'s existing reasoning that the history and the commit list are the half
of deploying a client may use: watching is the same kind of read as the history.

`KEEPALIVE_MS` is already 25 seconds and matters more here than for container logs, because a build can
sit silent for minutes pulling layers and an idle proxy would otherwise close the connection.

## The portal

A new client component beside `deployPanel.tsx`. The Deploys tab becomes a two-column grid in
`site.module.css`, stacking below roughly 900px.

It consumes the stream the way `logs.tsx` does, including the order, which is not the obvious one. It
does not pre-flight. It opens the `EventSource` first, and only if that errors before it has opened does
it ask the same endpoint again plainly, because `EventSource` reports an HTTP error without handing over
the body and the relay's refusal document is already in the caller's language. The same `MAX_LINES` cap
of 2000 and the same tail slice, and scroll-follow matching the log view rather than a second behaviour
invented here.

The three kinds render differently: `step` as the narrative, `output` monospaced and dimmer beneath it,
`end` closing with the outcome and duration. A change of `startedAt` clears the column.

It cooperates with `settling.tsx` rather than duplicating it. `settling` already owns "what was asked
for, and where it ends", and is what puts the *Asked for* box on screen; that box keeps owning the
request, and the column owns what the deploy is doing. On `end` the column triggers the `router.refresh()`
`settling` already has, so the history row appears without a poll.

`Show what it printed` in the history stays exactly as it is. It becomes partly redundant for the most
recent deploy, but it is still the only way to see the output of a deploy three rows down, and removing
it to avoid a small overlap would cost more than the overlap does.

## Failure modes

**The stream is a tail of the environment, not of one deploy**, so the poller starting the next one needs
no reconnection. `startedAt` is the boundary.

**An agent restart mid-deploy loses the buffer and the deploy**, because the buffer is in memory and the
deploy is an in-process promise. That is existing behaviour. What this adds is the obligation to say the
stream dropped rather than leave a stale half-log looking like a deploy still running.

**A client without the `deploy` capability** is refused as an HTTP error on the `EventSource` itself,
which hands over no body. The column closes that stream rather than leaving `EventSource` to retry
forever behind a silent failure, asks the same endpoint again plainly to get the refusal in words, and
says it once, with a Try again for whoever wants another attempt.

**Chattiness is bounded at both ends**: the ring in the agent, `MAX_LINES` in the browser.

**No new secrets, and more of the same bytes.** Everything the stream carries is something a deploy
already produces, and it is gated by the same capability and the same owner policy as the history. It is
not the same volume, though: `record.output` is `tail()` of the one command that failed, while the stream
carries every compose command's output as it goes, up to the ring's bound, and the phase lines besides,
which name paths on the server's filesystem. A superset of what the history shows, gated identically. It
changes when and how much is seen, not who can see it.

## Testing

- **The buffer:** caps by bytes, replays then goes live, several subscribers at once, dropped when the
  next deploy starts, unsubscribe on close.
- **The wraps:** `deps.log` lines reach the buffer as `step`, compose lines as `output`, and
  `record.output` is byte-for-byte what it is today. That last is the regression guard that matters,
  because it is the one most likely to break silently.
- **Protocol:** `deploy-watch` parses, refuses an unknown environment and extra keys.
- **Routes:** `GET` and `POST` on one path reach different handlers, the capability gate refuses, and the
  refusal arrives before the stream opens.
- **Portal:** renders the three kinds, caps lines, surfaces a refusal, clears at a `startedAt` boundary.

The question no test could settle, whether compose output arrives line by line or in one lump at the end,
was answered by a spike against a real build on the dedi (compose v5.1.3) before this design was
finalised. **It streams.** A two step build with a four second sleep in each step, spawned exactly as
`createSpawnRunner` spawns it, with no TTY and default progress:

```
 1.370 out #6 0.268 A-START
 5.373 out #6 4.269 A-DONE     <- 4.003s apart, matching the sleep
 5.755 out #7 0.355 B-START
 9.757 out #7 4.356 B-DONE     <- 4.002s apart
```

So no `--progress plain` is needed, and a `RUN` step's own output is relayed live, prefixed with the step
number and its elapsed time. The column gets real build output as it happens, which is what the feature
rests on.

## What this deliberately does not do

- No persistence. A deploy's output is not written to disk and does not survive an agent restart. The
  history keeps being the durable record, as it is today.
- No streaming for lifecycle actions or backups, though the same rail would serve them.
- No change to what a deploy does, in what order, or to anything it writes.
