# Send composition modules — one composer per kind for the path from template to wire

**Status:** accepted

## Context

The codebase has one cross-cutting concern that crosses five
send-producer files but sits behind no interface: how a send producer
turns a template + recipient signal into the wire-ready `{ subject,
html, headers, attachments }` payload that `sendProviderDispatch`
ships. Every producer open-codes the same composition.

`lib/sendProviders/dispatch.ts:sendProviderDispatch` is the
downstream chokepoint for the **send** (provider attempt, retries,
health) — ADR-0020 deepened it and every producer now routes through
it. The composition step *upstream* of dispatch has no equivalent.
Five send producers across four files re-implement the same
personalize + transform + header-build surface from scratch.

### Caller landscape — send producers

| Producer | File:line | Runtime | Personalize subject | Personalize html | View-in-browser | Footer (unsub/prefs) | Wrap tracked links | Tracking pixel | List-Unsubscribe header | Attachment fetch+scan |
|---|---|---|---|---|---|---|---|---|---|---|
| Campaign worker | `emailWorker.ts:206-378` | Node | yes (escape) | yes (escape) | yes when archive enabled | yes when `audienceType !== 'segment'` | yes | yes | yes for topic campaigns | yes |
| Campaign orchestrator (snapshot) | `emails.ts:562` | Node | yes (no escape) | — | — | — | — | — | — | — |
| Campaign orchestrator (archive) | `emails.ts:309` | Node | — | yes with empty placeholder contact (no escape) | — | — | — | — | — | — |
| Transactional worker call | via `emailWorker.ts:259-263` | Node | yes (escape, against `dataVariables`) | yes (escape, against `dataVariables`) | — | — | — | — | — | yes |
| Test send | `emailsSending.ts:86-87, 185-186` | Node | yes (no escape) | yes (no escape) | — | — | — | — | — | — |
| Automation step | `automations/steps/email/index.ts:92-93` | Node | yes (no escape) | yes (no escape) | — | — | — | — | — | — |

Five producers. Four files. Three implementations of `replaceVariables`
(byte-identical pairs that diverge on HTML escaping). Two
implementations of `getTrackingPixelUrl` / `getTrackedLinkUrl` across
the V8 / Node runtime boundary. `transformEmailHtml` (75 LOC of
cheerio) buried in the worker. Six transformation toggles (view-in-
browser, footer, tracking pixel, link wrapping, list-unsubscribe header,
attachment scan) gated by inline `if (args.type === 'campaign')` checks
inside one giant action handler. Every variation independently
maintained, with no single test surface for "what shipped looks like."

### 1. Three `replaceVariables` implementations diverge silently on escaping

| Implementation | File:line | Escape policy |
|---|---|---|
| `replaceVariables` | `lib/emailHelpers.ts:59` | none (raw substitution) |
| `replaceVariables` | `automations/steps/shared/personalize.ts:6` | none (byte-identical to above) |
| `replaceVariables` | `emailWorker.ts:152` | escapes via inline `escapeHtml` |

Callers pick an escape policy by choosing which import to use. The
choice is invisible at the call site and undocumented. Today's surface:

- The campaign snapshot subject (`emails.ts:562`) uses
  `lib/emailHelpers.replaceVariables` — no escape.
- The wire subject for the same campaign send (`emailWorker.ts:268`)
  uses `emailWorker.replaceVariables` — escapes.
- The dashboard that displays `emailSends.personalizedSubject` shows
  one string; the recipient's inbox shows another, if the contact's
  `firstName` contains an HTML-significant character (`<`, `&`, `'`).
  The bug exists today; no test catches it.

The escape policy *is* per-context (HTML body needs escaping; plain
subject lines do not need it because email clients don't render HTML
in subject lines). Today's encoding hides the policy in the function
identity. A single function with an explicit escape argument is the
fix.

### 2. Two `getTrackingPixelUrl` / `getTrackedLinkUrl` implementations across runtimes

| Implementation | File:line | base64url via |
|---|---|---|
| V8 | `delivery/tracking.ts:41-54` | inline `stringToBase64Url` using `TextEncoder` + `btoa` |
| Node | `emailWorker.ts:27-38` | `Buffer.from(str, 'utf-8').toString('base64url')` |

Both produce the same URL format. The cheerio-side rewriter
(`emailWorker.ts:122`) calls the Node version; the click handler at
`delivery/trackingHttp.ts` calls the V8 version to decode the
`originalUrl`. They MUST stay in sync or tracking redirects break.
No test enforces the contract.

The split exists because `emailWorker.ts` is `'use node'` and can use
`Buffer`; `delivery/tracking.ts` runs in Convex V8 where `Buffer` is
unavailable. But Convex V8 ships `TextEncoder` + `btoa`, which is
enough for a single implementation that works in both runtimes.

### 3. `transformEmailHtml` is buried in the worker

`emailWorker.ts:63-139` defines `transformEmailHtml(html, options)` —
75 LOC of cheerio doing four injections in one DOM pass (view-in-
browser, footer, link wrapping, tracking pixel). It has its own test
file (`__tests__/emailWorker.test.ts:259-735` — 476 LOC of tests
covering exactly this function), but it's not importable from
anywhere else and its options-flag shape is undocumented outside the
type definition.

The function is correct and well-tested. Its location is the friction:
the only call site is `emailWorker.ts:257`, gated behind `if
(args.type === 'campaign')` and only after assembling the options
inline from a dozen worker args. The "what transformations apply" policy
lives at the same line as the "apply them" code, with no name on the
policy itself.

### 4. Campaign-only transformation policy encoded as inline branches

`emailWorker.ts:222-258` is the policy declaration for campaign
transformations:

```ts
if (args.type === 'campaign' && args.email) {
  personalizedHtml = replaceVariables(...);
  const transformOptions: EmailHtmlTransformOptions = {};
  if (args.viewInBrowserUrl) { ... }
  if (args.siteUrl && args.contactId && args.audienceType !== 'segment') { ... }
  if (args.convexSiteUrl && args.emailSendId) { ... }
  if (Object.keys(transformOptions).length > 0) {
    personalizedHtml = transformEmailHtml(personalizedHtml, transformOptions);
  }
} else if (args.type === 'transactional' && args.dataVariables) { ... }
```

This is the *policy* — what each kind gets — encoded as an if-chain
inside the *mechanism* (the worker). Adding a fifth send producer
(today: automation, archive_snapshot, test all live as their own
ad-hoc paths bypassing the worker) requires re-implementing whichever
subset of these transformations the new producer needs, picking a
`replaceVariables` to import, and hoping the escape policy matches
the precedent. None of this is enforced.

### 5. Three producers bypass the worker entirely

- `emailsSending.ts` (test sends) — sync dispatch, no workpool, no
  transformations.
- `automations/steps/email/index.ts` — sync dispatch, no workpool, no
  transformations (automation emails do not currently carry
  unsubscribe links — see §6).
- `emails.ts:309` (archive snapshot) — no dispatch at all, just
  produces an HTML snapshot for the archive table; uses a placeholder
  contact with empty strings.

Each bypass exists for a valid reason (sync feedback, sync dispatch,
non-dispatch write) but each one re-implements its own composition.
The worker is the only fully-deep path today.

### 6. Behavioural quirks the deepening surfaces (not changes)

- **Automation emails lack unsubscribe links and tracking.** Today's
  automation step at `automations/steps/email/index.ts:116-126` ships
  the personalized html directly via `sendProviderDispatch` with no
  cheerio pass. This is arguably a product bug (automation emails
  arrive without a way to opt out), but it's the current behaviour.
  The deepening preserves it by giving the `automation` kind an empty
  `transformConfig`. If product later decides automation emails should
  include unsubscribe links, the change is one composer file.
- **Transactional emails lack tracking pixels.** Same shape — the
  worker's `if (args.type === 'campaign')` branch silently excludes
  transactional. Preserved by the `transactional` kind returning an
  empty `transformConfig`. Same change site if product decides
  otherwise.
- **The archive snapshot personalizes with an empty placeholder
  contact** (`emails.ts:309`). The placeholder is `{ email: '',
  firstName: '', lastName: '' }`. Recipients viewing the archive see
  `Hi !` for any `{{firstName}}` without a fallback, and `Hi friend!`
  for `{{firstName|'friend'}}`. The deepening lifts the placeholder
  into the `archive_snapshot` composer; behaviour unchanged.

### Shared framing

Per LANGUAGE.md's deletion test: deleting any one of the three
`replaceVariables` implementations today does not concentrate complexity
— the other two would diverge further. Deleting the V8 vs Node
tracking-URL pair likewise. Deleting `transformEmailHtml` would
collapse the worker into a 200-LOC inline cheerio script. Each is
shallow on its own.

Lifting them together behind one module produces real leverage: every
send producer declares its `kind` and gets the composition for free.
Adding a sixth producer is a new per-kind composer file plus a registry
entry; the wire-format details (escape policy, tracking URL format,
DOM-pass ordering) stay locked.

The interface is the test surface. Pre-deepening, "every kind's
composed output matches its declared policy" can only be tested by
spinning up each producer independently against a real provider — no
producer has such tests. Post-deepening, the per-kind composer tests
assert directly on the composed envelope; the worker's tests assert on
"applies whatever transformConfig it's handed."

Confidence: high. Pure consolidation. No new behaviour at any
producer (modulo the locked escape policy, which closes a silent drift
documented in §1). No schema change. Four files shrink; one new
module family lands; six tests collapse to one.

## Decision

Introduce a new module family at `convex/delivery/sendComposition/`,
one composer per `kind`, migrate the five producers to call into it,
and delete the three `replaceVariables` implementations + two
tracking-URL implementations they replace.

### New module family: Send composition (module)

```
convex/delivery/sendComposition/
├── index.ts                      # V8 — types, registry, entry points
├── personalization.ts            # V8 — single replaceVariables
├── trackingUrl.ts                # V8 — getTrackingPixelUrl, getTrackedLinkUrl (works in Node too)
├── transform.ts                  # 'use node' — transformHtml (cheerio)
├── campaign/index.ts             # V8 — composer for kind: 'campaign'
├── transactional/index.ts        # V8 — composer for kind: 'transactional'
├── test/index.ts                 # V8 — composer for kind: 'test'
├── archive_snapshot/index.ts     # V8 — composer for kind: 'archive_snapshot'
├── automation/index.ts           # V8 — composer for kind: 'automation'
└── __tests__/
    ├── personalization.test.ts
    ├── trackingUrl.test.ts
    ├── transform.test.ts
    └── composeForSend.test.ts    # per-kind composer tests
```

Two V8 entry points at `index.ts`:

```ts
// Cheap subject-only personalization. Used by the campaign orchestrator
// to write emailSends.personalizedSubject (SNAPSHOT) at enqueue time.
export function personalizeSubject<K extends SendCompositionKind>(
  input: ComposeInput<K>,
): string;

// Full composition. Used by the worker and by the synchronous
// dispatch paths (test, automation). Returns the wire-ready envelope
// plus the transformConfig the Node transform half consumes.
export function composeForSend<K extends SendCompositionKind>(
  input: ComposeInput<K>,
): ComposeOutput;

type ComposeOutput = {
  subject: string;
  html: string;
  headers: Record<string, string>;          // List-Unsubscribe, List-Unsubscribe-Post
  attachmentRefs: AttachmentRef[];
  transformConfig: TransformConfig | null;  // null = no transformations
};

type TransformConfig = {
  trackingPixelUrl?: string;
  trackedLinkBase?: { convexSiteUrl: string; emailSendId: Id<'emailSends'> };
  unsubscribeUrl?: string;
  preferenceUrl?: string;
  viewInBrowserUrl?: string;
};
```

One Node entry point at `transform.ts`:

```ts
'use node';
import * as cheerio from 'cheerio';
export function transformHtml(html: string, config: TransformConfig): string;
```

The discriminated `ComposeInput<K>`:

```ts
type SendCompositionKind = 'campaign' | 'transactional' | 'test' | 'archive_snapshot' | 'automation';

type ComposeInput<K extends SendCompositionKind> =
  K extends 'campaign'         ? CampaignInput        :
  K extends 'transactional'    ? TransactionalInput   :
  K extends 'test'             ? TestInput            :
  K extends 'archive_snapshot' ? ArchiveSnapshotInput :
  K extends 'automation'       ? AutomationInput      :
  never;
```

Each `<kind>Input` is a typed shape carrying exactly what that kind
needs. `CampaignInput` includes `contactInfo`, `audienceType`,
`trackingBaseUrl`, `siteUrl`, `convexSiteUrl`, `emailSendId`,
`viewInBrowserUrl`. `TransactionalInput` includes `dataVariables` and
`attachmentRefs` but no tracking fields. `TestInput` includes
`sampleContact` but no tracking. `ArchiveSnapshotInput` includes only
the template. `AutomationInput` includes `contactInfo` like campaign
but no tracking fields.

Per-kind composer:

```ts
// sendComposition/campaign/index.ts
export const campaignComposer: SendComposerModule<'campaign'> = {
  kind: 'campaign',
  compose(input) {
    const subject = personalize(input.template.subject, input.contactInfo, 'plain');
    const html = personalize(input.template.htmlContent, input.contactInfo, 'html');

    const headers: Record<string, string> = {};
    if (input.audienceType !== 'segment' && input.convexSiteUrl && input.contactInfo.contactId) {
      const lu = buildListUnsubscribeHeader(input.convexSiteUrl, input.contactInfo.contactId);
      headers['List-Unsubscribe'] = lu.listUnsubscribe;
      headers['List-Unsubscribe-Post'] = lu.listUnsubscribePost;
    }

    const transformConfig: TransformConfig = {};
    if (input.viewInBrowserUrl) transformConfig.viewInBrowserUrl = input.viewInBrowserUrl;
    if (input.siteUrl && input.contactInfo.contactId && input.audienceType !== 'segment') {
      transformConfig.unsubscribeUrl = getUnsubscribeUrl(input.siteUrl, input.contactInfo.contactId);
      transformConfig.preferenceUrl = getPreferenceUrl(input.siteUrl, input.contactInfo.contactId);
    }
    if (input.convexSiteUrl && input.emailSendId) {
      const base = input.trackingBaseUrl ?? input.convexSiteUrl;
      transformConfig.trackingPixelUrl = getTrackingPixelUrl(base, input.emailSendId);
      transformConfig.trackedLinkBase = { convexSiteUrl: base, emailSendId: input.emailSendId };
    }

    return { subject, html, headers, attachmentRefs: [], transformConfig };
  },
};
```

The other four kinds are smaller — `transactional` does
`dataVariables` substitution and returns `transformConfig: null`;
`test`, `automation`, `archive_snapshot` each declare one small policy
and return null transformConfig.

### Worker after deepening

The workpool action surface shrinks from 16+ flat args to two:

```ts
// emailWorker.ts (post-deepening)
export const sendSingleEmail = internalAction({
  args: {
    envelopeInput: envelopeInputValidator,   // discriminated union by kind
    sendRef: sendRefValidator,
  },
  handler: async (ctx, { envelopeInput, sendRef }) => {
    const composed = composeForSend(envelopeInput);
    const html = composed.transformConfig
      ? transformHtml(composed.html, composed.transformConfig)
      : composed.html;
    const attachments = await resolveAttachments(composed.attachmentRefs);

    const kind = resolveProviderKind(envelopeInput);
    const dispatched = await sendProviderDispatch(ctx, kind, {
      to: envelopeInput.to,
      from: envelopeInput.from,
      replyTo: envelopeInput.replyTo,
      subject: composed.subject,
      html,
      headers: Object.keys(composed.headers).length > 0 ? composed.headers : undefined,
      attachments,
    });

    if (dispatched.result.success) {
      return { success: true, providerMessageId: dispatched.result.id, providerType: dispatched.providerType, sendLatencyMs: dispatched.latencyMs };
    }
    throw new Error(dispatched.result.errorMessage || 'Unknown email sending error');
  },
});
```

~50 LOC of worker handler (down from ~170). The 65 LOC of attachment
fetch + ClamAV scan moves to a sibling helper at
`emailWorker.ts:resolveAttachments` (private to the file — single
caller, single use case).

### Replaces

| File:line | Pre-deepening | Post-deepening |
|---|---|---|
| `emailWorker.ts:63-139` (`transformEmailHtml`) | 75 LOC inline cheerio | moves to `sendComposition/transform.ts` |
| `emailWorker.ts:152-163` (`replaceVariables`) | 12 LOC inline, escapes | deleted; calls `sendComposition/personalization.ts` |
| `emailWorker.ts:27-38` (`getTrackingPixelUrl`, `getTrackedLinkUrl`) | 12 LOC Node Buffer impl | deleted; calls `sendComposition/trackingUrl.ts` |
| `emailWorker.ts:222-284` (per-type policy branch) | 62 LOC if-chain | composer-emitted `transformConfig` |
| `lib/emailHelpers.ts:59` (`replaceVariables`) | 17 LOC standalone | deleted; the timezone helpers stay |
| `automations/steps/shared/personalize.ts:6` (`replaceVariables`) | 17 LOC standalone | file deleted (it had no other exports) |
| `automations/stepWalker.ts:22` (re-export) | re-export line | deleted |
| `delivery/tracking.ts:10-22, 41-54` (V8 URL impl) | 24 LOC | deleted; calls `sendComposition/trackingUrl.ts`. `getEmailSendForTracking` stays (read-only Send lookup, used by `trackingHttp.ts`). |
| `emails.ts:309` (archive snapshot personalize) | inline `replaceVariables` with placeholder contact | `composeForSend({ kind: 'archive_snapshot', template })` |
| `emails.ts:562` (snapshot subject personalize) | inline `replaceVariables` per recipient | `personalizeSubject({ kind: 'campaign', template, contactInfo })` |
| `emailsSending.ts:86-87, 185-186` (test send personalize) | inline `replaceVariables` ×4 | `composeForSend({ kind: 'test', ... })` |
| `automations/steps/email/index.ts:92-93` (automation personalize) | inline `replaceVariables` ×2 | `composeForSend({ kind: 'automation', ... })` |

### Closes drift bugs

1. **Three `replaceVariables` divergence on HTML escaping** — closed
   by the single implementation with an explicit `escape: 'html' |
   'plain'` argument declared by each per-kind composer at the
   appropriate per-field site (subject = `'plain'`, html =
   `'html'`).
2. **Two `getTrackingPixelUrl` / `getTrackedLinkUrl` implementations
   across V8/Node** — closed by the single V8-pure implementation
   usable from both runtimes; `delivery/trackingHttp.ts` imports the
   same encode function it indirectly decodes, locking the format to
   one source.
3. **Duplicate subject personalization between snapshot and wire**
   (`emails.ts:562` no-escape vs `emailWorker.ts:268` escape) — closed
   by the orchestrator and worker both calling into the same
   `personalizeSubject` / `composeForSend` chain, sharing the same
   internal personalization with the same explicit `escape: 'plain'`
   for subject lines.
4. **Per-type policy as inline if-chain inside the worker** — closed
   by each per-kind composer declaring its `transformConfig`
   explicitly. The worker becomes policy-agnostic; it applies whatever
   composer it dispatches to.
5. **Placeholder-contact magic string at the archive snapshot site**
   — closed by the `archive_snapshot/index.ts` composer baking the
   placeholder once.
6. **Missing test surface for "what each kind ships"** — closed by
   per-kind composer tests at `sendComposition/__tests__/composeForSend.test.ts`.

### Tests

Four new test surfaces:

1. **Personalization tests** at
   `sendComposition/__tests__/personalization.test.ts`. Replaces
   `lib/__tests__/emailHelpers.test.ts` (`replaceVariables` parts),
   `__tests__/emailWorker.test.ts:10-167` (`replaceVariables` parts),
   and `__tests__/automationStepWalker.test.ts:167-200`
   (`replaceVariables` parts). One file covering: variable
   substitution with present / absent / null / empty values, fallback
   syntax `{{var|'fallback'}}`, escape: 'plain' (passthrough), escape:
   'html' (escapes `<`, `>`, `&`, `"`, `'`). The fallback string
   escape policy follows the value escape policy (consistency with
   today's worker behaviour).
2. **Tracking URL tests** at
   `sendComposition/__tests__/trackingUrl.test.ts`. Locks the URL
   format: ASCII input, UTF-8 multi-byte input, padding stripping,
   URL-safe alphabet substitution (`+` → `-`, `/` → `_`). One
   property test: encode → decode round-trip. Catches any future
   change that would silently break the encode/decode pairing across
   `sendComposition/trackingUrl.ts` and `delivery/trackingHttp.ts`.
3. **Transform tests** at `sendComposition/__tests__/transform.test.ts`.
   Replaces `__tests__/emailWorker.test.ts:259-735` (the
   `transformEmailHtml` block). Identical coverage — the function is
   the same, only its location moves. Existing test cases port directly.
4. **Per-kind composer tests** at
   `sendComposition/__tests__/composeForSend.test.ts`. One describe
   block per kind asserting the composed envelope shape:
   - `campaign` — full envelope with topic audience (tracking + footer
     + list-unsubscribe + view-in-browser) vs segment audience (tracking
     only, no footer, no list-unsubscribe).
   - `transactional` — subject + html personalized against
     `dataVariables`; null transformConfig; merged attachments.
   - `test` — subject + html personalized against sampleContact; null
     transformConfig.
   - `archive_snapshot` — subject passed through raw; html personalized
     with empty placeholder; null transformConfig.
   - `automation` — subject + html personalized against contactInfo;
     null transformConfig.

The worker's own tests (`__tests__/emailWorker.test.ts`) shrink to the
dispatch-flow tests only (provider routing, attachment scan, dispatch
result handling) — the personalization and transformation blocks move
to `sendComposition/__tests__/`.

### Out of scope for this ADR

- **Attachment fetch + ClamAV scan**. Stays in the worker as
  `resolveAttachments` (private helper). The deepening returns
  `AttachmentRef[]` from the composer; the worker resolves them at
  send time. Lifting attachment resolution into its own module fails
  the "two adapters = real seam" test — single caller, single use
  case, IO-heavy. If a second producer ever needs the same
  fetch+validate+scan flow, that's the seam to revisit.
- **Provider routing**. The composer does not select a provider. The
  worker continues to call `resolveRoute` against the `messageType`
  derived from the input kind (`campaign` → `'campaign'`,
  `transactional` → `'transactional'`, `automation` → `'automation'`,
  `test` → `'transactional'` — current behaviour). Provider routing
  lives in **Send route strategy (module)** (ADR-0020); this ADR does
  not touch it.
- **Adding unsubscribe links to automation emails**. The current
  behaviour is automation emails ship without unsubscribe links. The
  deepening preserves this by giving the `automation` kind a null
  `transformConfig`. Whether automation emails *should* carry
  unsubscribe links is a product decision out of scope here. If
  product decides yes, the change is one composer file.
- **AMP email rendering**. `packages/email-renderer/src/amp.ts`
  produces AMP-formatted output for templates that opt in.
  Composition for AMP is its own path — not a send producer in the
  current pipeline. A future ADR may add a sixth `kind: 'amp'`.
- **Send lifecycle effects**. The `audit_log`,
  `campaign_stats_sent`, and related effects on Send lifecycle
  transitions (ADR-0006) are unchanged. The composer is upstream of
  the lifecycle; the lifecycle is upstream of the dashboard. No
  change to the lifecycle's effect list.

## Consequences

**Closes the silent escape-policy drift across personalization.**
Every site that personalizes a subject or html body now declares its
escape policy explicitly at the per-kind composer file. Today the
choice is hidden in the import path.

**Closes the cross-runtime tracking URL drift.** One V8-pure
implementation, one test surface, one source of truth for the encode
side. `delivery/trackingHttp.ts` decodes against the same module's
inverse helper, locked to the same format by construction.

**Closes the "what each kind ships" test gap.** Today no producer has
a test that asserts on the full composed envelope. Post-deepening, the
per-kind composer tests do exactly that, with no provider mocking
required.

**Aligns with the existing module-family pattern.** Block module, Step
module, Contact activity module, Webhook event module, Integration
import provider adapter module, and now Send composition module — same
shape: per-kind module in its own folder, registry dispatch by literal,
compile-time `satisfies` check on the registry catching missing
methods. Adding a sixth kind is a one-folder change.

**Surface area:** net negative. The numbers (rough):

| Code site | Pre | Post |
|---|---|---|
| `emailWorker.ts` | ~380 LOC | ~110 LOC (handler + resolveAttachments) |
| `lib/emailHelpers.ts` | ~75 LOC | ~50 LOC (timezone helpers only) |
| `automations/steps/shared/personalize.ts` | ~22 LOC | deleted |
| `delivery/tracking.ts` | ~54 LOC | ~30 LOC (getEmailSendForTracking only) |
| `emails.ts:309-321` (archive snapshot) | ~12 LOC inline | ~3 LOC call |
| `emails.ts:556-568` (snapshot subject) | ~12 LOC inline | ~5 LOC call |
| `emailsSending.ts:86-87, 185-186` | ~8 LOC inline | ~4 LOC across both call sites |
| `automations/steps/email/index.ts:87-93` | ~7 LOC inline | ~3 LOC call |
| New `sendComposition/*` (5 composers + 4 leaves + tests) | — | ~600 LOC |
| Net | ~570 LOC | ~810 LOC |

LOC goes up by ~240, mostly tests that don't exist today. Production
LOC is roughly net-zero — the consolidation balances the new factory's
boilerplate.

**Migration:** four phases, each independently shippable. The
five-producer migration in phase 3 is the only multi-file phase; the
earlier phases extract leaves with zero behaviour change.

### Phase 1 — Extract personalization + tracking URL leaves

1. New `convex/delivery/sendComposition/personalization.ts` exporting
   `personalize(content, vars, { escape })`. Internal helper
   `replaceVariablesImpl` is private.
2. New `convex/delivery/sendComposition/trackingUrl.ts` exporting
   V8-pure `getTrackingPixelUrl` and `getTrackedLinkUrl`. Uses
   `btoa(String.fromCharCode(...new TextEncoder().encode(str))).replace(...)`.
3. `lib/emailHelpers.ts` re-exports `replaceVariables` from the new
   module to bridge while callers migrate. `automations/steps/shared/
   personalize.ts` and `emailWorker.ts:152` likewise re-export.
4. `delivery/tracking.ts` imports the new URL helpers. `emailWorker.ts`
   imports the new URL helpers (removing its own Buffer impl).
5. New tests at `sendComposition/__tests__/personalization.test.ts`
   and `sendComposition/__tests__/trackingUrl.test.ts`.

Shippable. No behaviour change.

### Phase 2 — Extract transform half

1. New `convex/delivery/sendComposition/transform.ts` (`'use node'`)
   with `transformHtml(html, transformConfig)`. Function body is
   identical to today's `transformEmailHtml`; only the location and
   the parameter name change.
2. `emailWorker.ts:63-139` deletes the inline `transformEmailHtml` and
   imports from the new module.
3. Existing tests at `__tests__/emailWorker.test.ts:259-735` move to
   `sendComposition/__tests__/transform.test.ts` unchanged.

Shippable. No behaviour change.

### Phase 3 — Introduce per-kind composers and migrate producers

1. New `convex/delivery/sendComposition/index.ts` with the registry,
   the `ComposeInput<K>` union, `personalizeSubject`, and
   `composeForSend`. Plus the five per-kind composer files.
2. New per-kind tests at
   `sendComposition/__tests__/composeForSend.test.ts`.
3. `emailWorker.sendSingleEmail` args shrink to `{ envelopeInput,
   sendRef }`. Callers update:
   - `emails.ts` campaign orchestrator: `personalizeSubject` for the
     snapshot, `envelopeInput: { kind: 'campaign', ... }` for the
     workpool enqueue.
   - `transactional/dispatch.ts`: `envelopeInput: { kind:
     'transactional', ... }` for the workpool enqueue.
   - `emailsSending.ts` test sends: call `composeForSend({ kind:
     'test', ... })` then `sendProviderDispatch` directly.
   - `automations/steps/email/index.ts`: call `composeForSend({ kind:
     'automation', ... })` then `sendProviderDispatch` directly.
   - `emails.ts:309` archive snapshot: call `composeForSend({ kind:
     'archive_snapshot', template })` and write the result.
4. The deprecated re-exports added in phase 1 stay until phase 4.

The workpool action signature change is the load-bearing edit in this
phase. Both producers (campaign orchestrator and transactional
dispatch) update in the same commit; the workpool args validator
becomes the discriminated union.

### Phase 4 — Delete the deprecated bridges

1. `lib/emailHelpers.ts:replaceVariables` deleted. The timezone
   helpers stay.
2. `automations/steps/shared/personalize.ts` deleted (single export,
   no longer needed).
3. `automations/stepWalker.ts:22` re-export deleted.
4. `emailWorker.ts:27-38` (`getTrackingPixelUrl`, `getTrackedLinkUrl`)
   deleted.
5. Test files at `lib/__tests__/emailHelpers.test.ts` and
   `__tests__/automationStepWalker.test.ts:167-200` delete their
   `replaceVariables` cases (the rest of those test files stays —
   they test other things).

Shippable. Final cleanup.

**Risk to in-flight calls:** none. The wire output for every producer
is byte-identical to today, modulo two intentional changes:
- The campaign snapshot subject becomes HTML-escaped (today it is
  not). The snapshot is read by the dashboard which renders it as
  HTML; the lack of escaping is a latent XSS surface (rendered subject
  shows `<script>` literally today, would show escaped `&lt;script&gt;`
  post-deepening). The change is a security improvement; the visible
  drift case is when contact `firstName` contains an HTML-significant
  character and the dashboard previously rendered it raw.
- The automation step's escape policy now matches the campaign worker's
  (HTML escape on html body, plain on subject). Today the automation
  step's `replaceVariables` does not escape — meaning automation emails
  with an HTML-significant character in a contact field could have
  shipped unescaped HTML in the body. Post-deepening, automation
  emails get the same html escaping campaigns do. Same security
  improvement.

Both intentional changes are documented above. If either turns out to
break a customer's reliance on the current behaviour, the per-kind
composer is the one place to revert.

**No risk to provider dispatch.** The composer is upstream of
`sendProviderDispatch`; the helper sees the same `{ to, from, subject,
html, headers, attachments }` shape it sees today.

**No schema change.** The `emailSends.personalizedSubject` SNAPSHOT
field is still written by the campaign orchestrator from the same
source; the difference is the source now lives in one module.
