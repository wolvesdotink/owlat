# Catalog modules — single-source-of-truth for cross-cutting kinds

**Status:** accepted

## Context

Three Convex backend "kinds" had their literal sets duplicated across the
schema validator, the `lib/validators` re-export, the public mutation args,
and (in some cases) hand-written markdown docs:

1. **Webhook events** — 8 subscribable + 1 synthetic (`test`) literals
   appeared in the `webhooks` and `webhookDeliveryLogs` schemas, the
   `webhookEventValidator` in `lib/validators`, plus three inline
   `v.union(...)` constructions in `webhooks/endpoints.ts` (`listByEvent`,
   `create`, `update`). Five places.
2. **Audit-log actions** — 58 action literals plus 15 resource literals
   appeared in the `auditLogs` schema, the `auditActionValidator` /
   `auditResourceValidator` in `lib/validators`, plus an out-of-band markdown
   catalog at `docs/audit-log-actions.md`. Four places per action.
3. **Contact activity types** — 12 literals in the `contactActivities`
   schema, with only 10 (the inbound types missing) in the public
   `contacts/activities.create` mutation — a real drift bug. Two places, one
   of them silently wrong.

Adding a new literal meant editing every site. Lists drifted; the activities
list above documents the bug that resulted.

Three separate parsers of an email address — `apps/mta/src/queue/groups.ts`,
`apps/mta/src/intelligence/contentScreening.ts`, `apps/imap/src/mime.ts` —
exhibited the same shape one level up: not a duplicated literal list, but
duplicated *parsing logic* at three increasing levels of sophistication.
MTA could reject an address IMAP accepted, or vice versa.

## Decision

For each of these cross-cutting kinds, introduce a **catalog module** —
one folder per concept, one file holding the literal list (or the parsing
primitives), and derived validators / typed exports.

The recipe:

1. A `<concept>/catalog.ts` file declares the literal list as a
   `[…] as const` tuple (preserves the literal union via
   `(typeof TUPLE)[number]`).
2. Convex validators are derived from the tuple via `v.union(
   ...TUPLE.map(l => v.literal(l)))`. The variadic spread loses literal
   narrowing in TypeScript, so the derived validator is cast back to
   `Validator<LiteralUnion>` exactly once at the catalog boundary —
   downstream consumers stay narrowed.
3. Schemas, `lib/validators`, and public mutation args import from the
   catalog. The schema's literal union and the public-API literal union
   stay in lock-step by construction.
4. Per-entry metadata that varies by kind (e.g. `description`,
   `isSubscribable`) lives on the catalog entry as an object literal, not
   a parallel switch elsewhere.

Concrete instances landed in this pass:

| Catalog | Location | Replaces |
|---|---|---|
| Webhook events | `apps/api/convex/webhooks/events.ts` | `WEBHOOK_EVENTS` const + 3 inline unions in `endpoints.ts` + `webhookEventValidator` in `lib/validators.ts` + 2 schema unions |
| Audit actions / resources | `apps/api/convex/auditActions/catalog.ts` | `auditActionValidator` + `auditResourceValidator` in `lib/validators.ts` + 2 inline schema unions in `schema/auth.ts` |
| Contact activity types | `apps/api/convex/contactActivities/catalog.ts` | Schema union in `schema/contacts.ts` + drifted mutation-args union in `contacts/activities.ts` |
| Email addresses | `packages/shared/src/address.ts` | Three increasing-sophistication parsers in MTA queue, MTA content screening, IMAP MIME |

## Considered options

1. **Per-entry module files** (mirroring ADR-0001's Block module): one folder
   per literal, each with its own `index.ts`. Rejected for the simpler
   cases — webhook events, audit actions, activity types have no per-entry
   behavior worth a folder. Reserved as the next step if per-entry behavior
   (formatters, payload validators, etc.) accumulates.
2. **Hand-maintained literal lists + a runtime assertion test** ensuring
   the two stay in sync. Rejected: the assertion would catch the drift but
   not prevent it; the bug we already shipped (`inbound_*` activity types
   missing from the public mutation args) is exactly what this approach
   tolerates.
3. **Codegen** (build-time script turning the catalog into a literal
   union). Rejected: TypeScript can already infer the union from a
   `as const` tuple via `(typeof TUPLE)[number]`; codegen would add a build
   step we don't need.

## Consequences

- Adding a new webhook event, audit action, audit resource, or contact
  activity type is a one-place change.
- The previous activities-schema-vs-mutation drift is impossible to
  re-introduce — both derive from the same catalog.
- The Convex validator type loses literal narrowing when constructed by
  variadic spread; the catalog's single cast back to
  `Validator<LiteralUnion>` keeps every downstream consumer narrowed (the
  `recordAuditLog` helper, the mutation args validation, the schema's
  `Doc<'auditLogs'>['action']` type, etc.).
- `apps/api/convex/docs/audit-log-actions.md` becomes generatable from the
  catalog (deferred — current state is hand-maintained until the catalog
  grows `description` / `details` shape fields).
- The three apps that parse email addresses agree on what counts as a
  valid sender. New address shapes (IDN, +tag, group syntax) are a
  one-place change in `@owlat/shared/address`.

## Follow-up work

- Per-action formatters for the dashboard activity feed currently live in
  `analytics/dashboard.ts` as a 13-entry switch over 58 audit actions.
  When the switch grows past ~25 entries, move it onto the catalog entries
  as an optional `formatDescription?` field — same shape as the Block
  module's optional `validate?` / `preflight?` hooks (see ADR-0001).
- The same recipe applies to: campaign status transitions, segment
  condition types, automation step types, and notification provider
  literals. None had a clear payoff in this pass — open follow-ups when
  their literal smear bites.
