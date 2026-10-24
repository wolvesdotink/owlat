# Observability

Where Owlat's logs and metrics are, what is redacted in them, and how to follow
one send from the Convex backend through the MTA and back. Commands shown
here were run against a `bun run dev:stack` backend (see
[development.md](./development.md)). For a self-hosted install, the operator
commands (`owlat logs <service>`, `owlat status`, `owlat doctor --json`) are in
the docs site under
[Maintenance → Diagnose first](https://docs.owlat.app/developer/self-hosting-maintenance#diagnose-first).

## Where the logs are

| Source                       | What it holds                                                                                        | Where to read it                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Convex functions             | `console.*` output and one line per function run (queries, mutations, actions, HTTP routes, crons)   | `convex logs` (below) or the Convex dashboard (`--profile dashboard` on a self-hosted install) |
| Convex backend container     | The backend's own log: startup, admin-key use, push and schema changes. Function output is not here. | `bun run dev:stack logs convex`; `owlat logs convex` on an install                             |
| MTA (`apps/mta`)             | Pino JSON on stdout, `service: "owlat-mta"`, ISO timestamps                                          | the container log (`owlat logs mta`)                                                           |
| IMAP server (`apps/imap`)    | Pino JSON, `name: "owlat-imap"`                                                                      | the container log                                                                              |
| Mail sync (`apps/mail-sync`) | Pino JSON                                                                                            | the container log                                                                              |
| Updater, web (Nitro)         | Plain stdout                                                                                         | the container log (`owlat logs updater`, `owlat logs web`)                                     |

The function log of this checkout's stack, from the stage directory:

```sh
cd .owlat-dev/api
../../node_modules/.bin/convex logs --history 5 --success
```

```text
Watching logs for dev deployment...
10/22/2026, 5:44:43 AM [CONVEX Q(campaigns/sendQueries:getDueScheduledCampaigns)] Function executed in 57 ms
10/22/2026, 5:44:43 AM [CONVEX M(mail/outboundCron:findOverdueDrafts)] Function executed in 145 ms
```

`--jsonl` prints raw events for piping into `jq`. Without `--success`, only
logged output and failures are shown. While `bun run dev:stack` runs, its
`[convex]` lines are the same stream.

### What the logs never contain

Process logs are de-identified at the source by `@owlat/shared/logRedaction`
(the MTA, IMAP and mail-sync loggers, and the Convex helpers that log
addresses):

- An email address becomes `redacted-<digest>@<domain>`. The digest is a
  stable, unsalted hash of the lowercased address, so the same recipient has
  the same token in MTA lines and Convex lines, and across restarts. Grep for
  the token to follow one recipient; the domain stays readable.
- A subject becomes `[subject len=<n> <digest>]`.

Persisted records meant for the UI (delivery logs, audit logs, the send rows)
keep the real values; they are not process logs.

### Structured events

New Convex log lines are named events written by `logEvent` in
`apps/api/convex/lib/runtimeLog.ts`. Each one is a single JSON object:

```json
{
	"event": "delivery.dispatch.completed",
	"level": "info",
	"orgId": "…",
	"sendId": "…",
	"workAttemptId": "…",
	"messageId": "send_…",
	"correlationId": "txn_…",
	"durationMs": 412,
	"outcome": "accepted",
	"detail": { "providerType": "mta" }
}
```

The top-level keys are a fixed list shared with the MTA's pino lines
(`@owlat/shared/logEvent`): `orgId`, `sendId`, `workAttemptId`, `messageId`,
`correlationId`, `durationMs`, `outcome`, `category`. Anything specific to one
event sits under `detail`. Filter on `"event":"<name>"` instead of the old
`[Tag]` text prefixes; lines that have not moved to `logEvent` yet still use
those prefixes.

| Event                                                           | Emitted by                                   | Level        |
| --------------------------------------------------------------- | -------------------------------------------- | ------------ |
| `delivery.dispatch.completed`                                   | Convex governed dispatch, once per attempt   | info / warn  |
| `mta.delivery.outcome`                                          | MTA, once per SMTP attempt                   | info / warn  |
| `mta.webhook.received`                                          | Convex, per MTA webhook event                | debug        |
| `mta.webhook.rejected`                                          | Convex, webhook refused by the ingress guard | warn         |
| `function.query.failed` / `.mutation.failed` / `.action.failed` | Convex public function builders, on a throw  | warn / error |
| `postbox.mta_intake.refused` / `.failed`                        | Convex Postbox send, per recipient           | error        |
| `postbox.forward.*`, `postbox.vacation_reply.*`                 | Convex delivery hooks                        | info / error |
| `runtime.event_loop.stalled`                                    | IMAP, mail sync, updater, per stall (below)  | warn         |
| `derived_field.drift`                                           | Convex drift sampler, per drifted parent     | warn         |
| `derived_field.skipped` / `derived_field.sampled`               | Convex drift sampler, per skip / per tick    | info         |

These replace the earlier `[Outbound] MTA /send …`, `[Forwarding] …`,
`[Vacation] auto-replied …` and `[mta Webhook] Ingress guard rejected …` lines,
so saved searches on those strings need the event name instead.

`function.<kind>.failed` is logged once per failed public query, mutation or
action, with the Operation-error `category` (`internal` for an uncategorized
throw), the caller's `orgId` once the auth floor resolved it, and, for actions,
`durationMs` (Convex holds the clock still inside a query or mutation, so those
carry none). Expected query failures are sampled at one in ten
(`detail.sampleRate`); `internal` failures are always logged. The error
message is not in this line; Convex's own failure line for the same request
has it. Argument-validation failures happen before the handler and only appear
in Convex's own line.

`derived_field.drift` means a cached field (`// AGGREGATED [<id>]` in the
schema) differed from a recount of what it caches, for one parent row. The
sampler (`apps/api/convex/maintenance/derivedFields/sampler.ts`) checks a few
parents per field every hour. `outcome` is `repaired` when it wrote the recount
back and `not_repaired` when the field's policy forbids it (a lifetime total
above its recount is never lowered). `detail` names the field, its table, the
parent id, and the `cached.<path>` and `recount.<path>` values. A steady stream
for one field points at a writer that misses an update. `derived_field.skipped`
names a parent whose recount would have read too much (`over_budget`) or whose
source is incomplete (`unverifiable`); nothing was written for it.

### The correlation id

Convex → MTA send-path requests carry an `x-owlat-correlation` header: the
intake (`POST /send`), the routing decision, Postbox outbound, and forwards and
auto-replies. Every call made through `mtaFetch` carries one too. Direct
operational calls that bypass `mtaFetch` (DKIM key registration, suppression
mirroring, DNSBL and health checks) do not; they are not about one message.

A transactional send uses the `correlationId` stored on its
`transactionalSends` row (`txn_…`); other sends get a fresh id per attempt
(`dsp_…`, `pbx_…` for Postbox, `fwd_…`/`vac_…` for forwards and auto-replies).
The id is read from the Send row at dispatch and is never part of the queued
envelope, so it does not enter the routing re-entry token's digest. The MTA
binds it to the job's log lines, keeps it on the queued job across deferrals,
stores it in the delayed-feedback record, and echoes it as `correlationId` on
the webhook events it reports for that message, including a later DSN or
complaint attributed to it. Convex logs it on receipt. A malformed header is
dropped, never refused.

The MTA's `mta.delivery.outcome` line follows the same shape: `outcome`,
`durationMs` and (for SMTP replies) `category` at the top level, the job's
bound `orgId`/`messageId`/`workAttemptId`/`correlationId`, and the attempt's
specifics (`to`, `ip`, `error`, `smtpCode`, `suggestedDelay`, `annotation`)
under `detail`. `detail.to` is de-identified like any other address.

To follow one transactional API call end to end:

```sh
cd .owlat-dev/api
../../node_modules/.bin/convex logs | grep 'txn_<id>'
owlat logs mta | grep 'txn_<id>'
```

## Metrics and health

| Endpoint       | Service        | Auth                         | Use                                                                                                                                     |
| -------------- | -------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /metrics` | MTA            | none (internal network only) | Prometheus text: queue depth and the MTA's counters                                                                                     |
| `GET /metrics` | IMAP server    | none (internal network only) | Prometheus text: process metrics, on its own listener (`IMAP_METRICS_PORT`, default 9464; `0` turns it off)                             |
| `GET /metrics` | mail sync      | none (internal network only) | Prometheus text: process metrics, on the worker's API port (3200)                                                                       |
| `GET /metrics` | updater        | none (internal network only) | Prometheus text: process metrics, on the updater's port (3200)                                                                          |
| `GET /livez`   | MTA, updater   | none                         | Liveness of the HTTP loop; what the container healthchecks call                                                                         |
| `GET /health`  | MTA            | none                         | Diagnostic: DNS identity, outbound SMTP reachability, Redis, queue worker heartbeat. Slow by design; do not poll it as a liveness probe |
| `GET /health`  | mail sync      | none                         | `{ ok: true }` when the HTTP server answers                                                                                             |
| `GET /health`  | updater        | updater secret               | Update state and the running stack                                                                                                      |
| `GET /version` | Convex backend | none                         | The backend answers; the compose healthcheck uses it                                                                                    |

The shipped compose file publishes the MTA's HTTP port on the host's loopback
only (`127.0.0.1:${MTA_HTTP_PORT:-3100}`), so `/metrics` can be scraped from the
host itself or from inside the Docker network. The IMAP and mail sync ports
are not published, and the updater's is published on the host's loopback at
most (the VPS template does; the development compose file does not). Scrape
them from a container on the same network: `http://imap:9464/metrics`,
`http://mail-sync:3200/metrics`, `http://updater:3200/metrics`.

### Process metrics and event-loop stalls

The IMAP server, mail sync and the updater serve prom-client's default process
metrics: CPU (`process_cpu_*`), resident memory
(`process_resident_memory_bytes`), heap and GC (`nodejs_heap_*`, `nodejs_gc_*`),
open handles and event-loop lag (`nodejs_eventloop_lag_*`, reset at every
scrape). None of them carries a per-request or per-user label.

Each of the three also samples its own event loop every 10 seconds. When the
loop was blocked for a second or more, it counts the stall in
`nodejs_eventloop_stalls_total` and writes one warning line, whether or not
anything scrapes `/metrics`:

```json
{
	"event": "runtime.event_loop.stalled",
	"durationMs": 2500,
	"detail": { "thresholdMs": 1000, "utilization": 0.29, "rssMb": 182, "heapUsedMb": 61 },
	"msg": "event loop stalled for 2500 ms"
}
```

`utilization` is the share of the 10-second window the loop spent running
code. The line is written when the loop runs again, so a process that never
unblocks logs nothing; its container healthcheck catches that. The updater
writes the same record as text after `[updater] event loop stalled for … ms`.

### MTA metric labels

`mta_fbl_complaints_by_campaign_total` labels the first 100 campaigns that
receive a complaint after the MTA starts by their campaign id; complaints for
later campaigns are counted under `campaign="other"`, so the sum over all
series is still the number of attributed complaints. Its `isp` label is one of
`microsoft`, `yahoo`, `aol`, `comcast`, `google`, `mailru` or `unknown`. The
per-campaign complaint rate and the `campaign.complaint_rate` alert are
tracked under the real campaign id regardless of this label.

## Following one send

A send has one identifier end to end: the **provider message id**.

1. **Convex row.** A campaign send is a row in `emailSends`, a transactional
   send a row in `transactionalSends`. Both carry `providerMessageId` once the
   transport accepted the message, indexed as `by_provider_message_id`.

   ```sh
   cd .owlat-dev/api
   ../../node_modules/.bin/convex data emailSends --limit 1
   ```

2. **MTA intake.** For the built-in MTA, Convex posts the send with
   `messageId` set to the send's idempotency key, and that value is what comes
   back as `providerMessageId`. A governed send also carries a
   `workAttemptId`, the identity of one bounded attempt; correlation stays on
   `messageId`. In the MTA's JSON log, filter on `"messageId":"<id>"` or on the
   request's `"correlationId"` (above).
3. **MTA delivery log.** Every delivery event (delivered, deferred, bounced,
   suppressed, screened, failed, expired) is written to a per-day Redis stream.
   `GET /delivery-logs/<messageId>` on the MTA returns the events of one
   message; `GET /delivery-logs?date=YYYY-MM-DD&status=bounced` lists a day.
   Both need the MTA master key.
4. **Back to Convex.** The MTA reports each outcome to the Convex site route
   `POST /webhooks/mta`, signed with the shared webhook secret. The handler
   finds the row by `providerMessageId` and moves its status. A report that
   cannot be delivered goes to the MTA's webhook dead-letter queue and is
   retried; one that matches no send is kept in `unresolvedFeedback` (see
   [Platform operations](https://docs.owlat.app/developer/platform-operations)).
5. **Recipient view.** The recipient's redacted token (above) ties together
   lines that do not carry the message id, such as suppression checks and
   per-domain throttling.

Other transports (SES, Resend, SMTP relay, Mandrill) return their own message
id as `providerMessageId`, and their feedback webhooks look the row up the
same way.

## Where to look first

| Symptom                            | First look                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The app shows a connection error   | `bun run dev:stack status`; the backend's `/version`                                                          |
| A function throws                  | `convex logs` (failures are always shown)                                                                     |
| A send stays queued                | The row's `providerMessageId`; if set, the MTA delivery log for it; if not, the Convex log of the send action |
| A send is "sent" but never arrives | MTA delivery log events for the `messageId`, then the MTA log for its deferrals                               |
| Bounces never update the row       | MTA webhook DLQ, then `unresolvedFeedback`                                                                    |
