# Slack approvals — Tier-2 reference connected app

A worked example of an Owlat **connected app** (Tier 2): an out-of-process
service that Owlat talks to over the scoped API and the **signed synchronous
hook** protocol (PP-24). It implements one thing — a **restrict-only hold gate**
— and demonstrates the whole Tier-2 security envelope end to end.

## What it does

When Owlat is about to auto-send a reply it calls this app's `gate` hook — that
is the contract this app implements. **Owlat does not make that call yet**: the
hook protocol, signing, validation and delivery logging are implemented and
tested, but no pipeline stage invokes `invokeHook`, so this reference runs
against the protocol (and its own suites), not against live traffic. See the
deferral note on
[Connected Apps](../../../apps/docs/content/3.developer/46.plugin-connected-apps.md).
On a call, the app:

1. the **first** time it sees a draft, opens an approval request, posts the
   pending draft to a Slack channel with **Approve / Reject** buttons, and
   **objects** (holds the send, routes to human review);
2. authenticates each Slack button click as a signed Slack callback, then
   records it as a vote, enforcing **one vote per person**, an **expiry
   window**, and a configurable **quorum**;
3. stops objecting (`no-objection`) **only** once a real human quorum approves
   inside the window. A rejection, an expiry, or any fault keeps holding.

## Why it is safe

- **It can never force a send.** The only two answers the `gate` hook can
  produce are `no-objection` and `objection` — a `RestrictOnlyGateResult`. There
  is no shape that approves or unblocks. `no-objection` merely withholds _this
  app's_ objection; Owlat still runs its own core gates before anything leaves.
  (`gateHandler.test.ts` proves an approved Slack quorum cannot flip a
  core-blocked decision to allowed.)
- **It fails closed toward holding.** A missing/forged Owlat signature, a
  replayed request, an unreadable payload, a Slack outage, an expired window, or
  an internal error all resolve to `objection`. Owlat's own hook client also
  fails a gate closed on any transport failure, so the hold is preserved on both
  sides.
- **Callbacks are authenticated.** Slack requests are verified with the `v0`
  signing scheme (constant-time HMAC + a 5-minute freshness window); Owlat
  requests are verified with the PP-24 canonical HMAC scheme, with an optional
  nonce replay guard. Anything that does not verify records no vote.
- **Tenants are isolated.** Approvals are keyed by `(organizationId, id)`, so
  one Owlat tenant's holds are never reachable through another tenant's ids.
- **Request bodies are capped.** Both inbound surfaces reject a raw body larger
  than 64 KiB (`body_too_large` → 401 / held gate) _before_ any HMAC or
  `JSON.parse` runs, so a forged request cannot make the app hash an
  attacker-sized payload. This is defence in depth — the HTTP host in front of
  the app must also cap the request body.

## Wiring it up (operator)

Add `slackApprovalsPlugin` (from `src/manifest.ts`) to `plugins.config.ts`, run
codegen, then register a connected app bound to the `slack-approvals` plugin
with the `send:gate` capability and the app's endpoint URL. Configure the Slack
signing secret, bot token, channel, quorum, and window through the plugin
settings. Point the app's two routes at `serveGateHook` (the Owlat hook) and
`handleSlackCallback` (the Slack interaction endpoint).

Everything here is runtime-neutral (`crypto.subtle` only) and has no network in
its tests, so each module is independently verifiable.
