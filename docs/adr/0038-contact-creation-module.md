# Contact creation module — uniform created-effect bundle above resolution

**Status:** accepted

## Context

ADR-0008 built the **Contact resolution (module)** as a deliberately
effect-free find-or-create primitive: it returns
`{ contactId, action }` and leaves activity logging, automation-trigger
fanout, and contact-count maintenance to callers, keyed off `action`
(see ADR-0008 "The module does *not* own" + follow-up #5).

In practice the "what fires when a Contact is created" decision got
copy-pasted, and drifted. Tracing every `resolveContact` caller that can
create a Contact:

| Create path | mode | `incrementContactCount` | `contact_created` trigger | `created` activity |
|---|---|:--:|:--:|:--:|
| `contacts/contacts.ts:create` | strict | ✅ | ✅ | ❌ |
| `contacts/contacts.ts:createForTeam` | strict | ✅ | ✅ | ❌ |
| `contacts/organization.ts:createForOrganization` | strict | ✅ | ✅ | ❌ |
| `contacts/organization.ts:createForOrganizationInternal` | strict | ✅ | ✅ | ❌ |
| `inbox/messages.ts:receiveMessage` | upsert | ❌ | ❌ | ✅ |
| `webhooks/channels.ts:processInboundChannel` | upsert | ❌ | ❌ | ❌ |
| `transactional/dispatch.ts:dispatch` | upsert | ❌ | ❌ | ❌ |
| `forms/submission.ts:submit` | upsert | ❌ | ❌ | ❌ |
| `automations/triggers.ts:sendEvent` | upsert | ❌ | ✅ (ad-hoc) | ❌ |

(`contacts/import.ts` is excluded — it is its own deepened module,
ADR-0019, owning a *batched* `incrementContactCount(imported)` and a
per-row composition.)

**No single create path fires all three effects.** Two are outright bugs:

1. **`cachedContactCount` undercounts.** It is incremented only by the
   four strict paths (plus the batched import path). A Contact created by
   replying to an email, by an inbound SMS/WhatsApp/chat webhook, by a
   transactional send, by a form submission, or by the `sendEvent`
   track API never increments the counter. For an inbox product those are
   the common create paths.
2. **The `contact_created` automation trigger silently never fires** for
   those same four paths. A "when a contact is created → send welcome"
   automation does not run for someone who reached the org by replying to
   an email or filling in a form.

A third inconsistency: the `created` **Contact activity** is recorded by
only one of the nine paths (inbox); and the `contact_created` trigger is
fired three different ways — `ctx.runMutation(fireContactCreatedTrigger)`
in the strict paths, an inline `fireTrigger('contact_created', …)` in
`sendEvent`, and not at all in the four inbound paths.

Per LANGUAGE.md's deletion test, the scatter has *already* produced
divergent, incomplete effect sets in the wild — the event "a Contact came
into existence" has no owner.

## Decision

Add one module, **Contact creation**, at
`apps/api/convex/contacts/creation.ts`, owning the uniform created-effect
bundle. Its single entry point wraps the (unchanged) resolution primitive:

```ts
export async function createContact(ctx, signal: ResolveSignal): Promise<ResolveResult> {
  const result = await resolveContact(ctx, signal);
  if (result.action === 'created') {
    await incrementContactCount(ctx, 1);
    await ctx.runMutation(internal.automations.triggers.fireContactCreatedTrigger, {
      contactId: result.contactId,
    });
    await recordContactActivity(ctx, {
      literal: 'created',
      contactId: result.contactId,
      metadata: { source: signal.source },
    });
  }
  return result;
}
```

Every *single*-Contact create path calls `createContact` instead of
`resolveContact` + hand-written effects. Callers keep their own *domain*
effects layered on top (inbox still writes its `inbound_received`
activity; the form still writes its submission row); the module owns only
the trio.

### Resolution stays the pure primitive (the load-bearing constraint)

The trio sits in a layer *above* `resolveContact`, not inside it, because
the **Contact import (module)** (ADR-0019) fires *one* batched
`incrementContactCount(imported)` per page and owns its own per-row
composition. If the created-effects moved into `resolveContact`, import
would double-count and need a `skipEffects` opt-out — re-coupling exactly
what ADR-0008 separated. So: single-create goes through Contact creation;
import alone calls `resolveContact` directly. Enforcement is by
convention + CONTEXT.md, not a type wall — import legitimately needs the
primitive, so a hard wall would buy no safety pre-launch.

### Created-effects only

The module's callers run `strict` or `upsert`, which yield only
`created` / `matched` (never `updated`). The `merge`/`updated` case arises
solely in import. So the module fires on `created` and is a no-op on
`matched`; it needs no `updated` branch.

### Refinement of ADR-0008

ADR-0008 said the `created` activity is "not automatic: callers
explicitly insert it." That stays true of *resolution* (it still touches
no activities). What changes is that the `created` activity — like the
count and the trigger — is now owned by the creation layer rather than
copy-pasted per caller. Domain-specific activities (`inbound_received`,
etc.) remain caller-owned, exactly as before. This closes ADR-0008
follow-up #5 for the creation event specifically.

## Considered options

### Where the effects live

1. **A layer above resolution** *(chosen)* — `createContact` wraps
   `resolveContact`. Keeps resolution pure; import keeps the bare
   primitive; no double-count.
2. **Inside resolution, gated on `created`** — fewer layers, but reopens
   ADR-0008 and forces a batched/`skipEffects` knob for import. Rejected.
3. **An `applyContactCreatedEffects` helper the caller invokes after
   resolve** — concentrates the trio but keeps the forgettable
   `if (action === 'created')` guard at every call site, i.e. the same
   shape that caused the drift. Rejected.

### Enforcement

1. **Convention + CONTEXT.md relationship note** *(chosen)* —
   `resolveContact` stays exported (import needs it); the rule
   "single-create goes through Contact creation, only import calls
   resolution directly" is recorded so future callers route correctly.
2. **Make single-create resolution unreachable** — rejected: import
   shares the primitive, so a hard wall would need an awkward split for no
   real safety gain pre-launch.

## Consequences

### Call sites

Nine single-create sites swap `resolveContact(...)` + inline effects for
`createContact(...)`:

- The four **strict** mutations shed their two hand-written effect lines
  (`incrementContactCount` + `fireContactCreatedTrigger`).
  `contacts.ts:create` keeps its session-specific `trackEvent` +
  `recordAuditLog`.
- The five **upsert** paths (inbox, channel webhook, transactional, form,
  and `sendEvent`) gain the effects they were missing — all gain the count
  + `created` activity; the four inbound paths additionally gain the
  trigger, and `sendEvent`'s ad-hoc `contact_created` call is unified into
  the module. `inbox`'s inline
  `if (action === 'created') recordContactActivity({ literal: 'created' })`
  block moves into the module.

`contacts/import.ts` is untouched — it keeps calling `resolveContact`
directly with its batched count.

### Behavior change (the point)

- `cachedContactCount` now counts Contacts created via inbound email,
  channel webhook, transactional send, and form.
- `contact_created` automations now fire for those paths.
- All nine paths now write a uniform `created` activity carrying
  `metadata.source`.

Strict-path Contacts (admin/API) now also get a `created` activity, which
they previously lacked — intended uniformity, not a regression.

### New module surface

`creation.ts` exports `createContact(ctx, signal)` (the in-process entry)
and a `create` `internalMutation` wire surface (symmetric to resolution's
`resolve`, used by the integration test). `resolution.ts` exports
`ResolveSignal` and renames its private row-insert helper
`createContact` → `insertContactRow` to free the name.

### Test surface

`__tests__/contactCreation.integration.test.ts` — the effect bundle gets
one test surface: a `created` call fires count + trigger (seeded
`contact_created` automation → one run) + a `created` activity carrying
`metadata.source`; a second `upsert` `matched` call fires none of the
three; `source` propagates into the activity. The two production bugs
become regressions here.

### Migration

Pre-production; no data backfill. `cachedContactCount` was already
drifting low; a one-time `reconcileContactCount` can true it up if
desired, but isn't required (no production data per the single-org
memory).
