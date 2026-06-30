# Email editor bridge module — one app-side owner for the EmailBuilder↔Convex binding, closing the three-copy upload pipeline + load/dirty/save loop

**Status:** accepted

## Context

The `EmailBuilder` component (`packages/email-builder`) is hosted by three
`apps/web` pages — the **Email template** editor, the **Transactional
email** editor, and the **Saved block** editor. Each page open-codes the
same *producer-side* binding: it builds the `EmailBuilderHandlers` object
the builder injects, and it runs the same load→dirty→save loop around the
canvas.

The handler **contract** already has an owner. `EmailBuilderHandlers` is
declared once at `packages/email-builder/src/types/editor.ts:44-56`,
provided through `provideEmailBuilderHandlers` / `useEmailBuilderHandlers`,
and consumed cleanly by the builder's own `useImageUpload`
(`composables/useImageUpload.ts:86-91` — it validates type/size and routes
failures to `handlers.onError`). The gap is on the *producing* side:
nothing owns "build the Convex-backed handlers and run the editor's
lifecycle." Three pages each build it from scratch.

```ts
// packages/email-builder/src/types/editor.ts:44-56 — the contract (stays)
export interface EmailBuilderHandlers {
  uploadImage: (file: File) => Promise<ImageUploadResult>;
  pickFromMediaLibrary?: (onSelect: (r: ImageUploadResult) => void) => void;
  savedBlocks?: {
    fetch: (params?: { search?: string }) => Promise<SavedBlock[]>;
    save: (block: { name: string; content: EditorBlock[] }) => Promise<void>;
  };
  onError?: (message: string) => void;
}
```

### Caller landscape — "host the EmailBuilder against Convex"

| Surface | File | `uploadImage` | `savedBlocks` | media picker | load→dirty loop | `save()` |
|---|---|---|---|---|---|---|
| Email template editor | `dashboard/emails/[id]/edit.vue` | `:153-188` **verbatim** | `:193-206` | `:142-149` | `:79-139` | render HTML + translations + `linkedBlockIds` → `emailTemplates.emails.update` (`:210-250`) |
| Transactional editor | `dashboard/transactional/[id]/edit.vue` | `:177-212` **verbatim** | `:217-230` | `:165-173` | `:90-163` | render + translations + `linkedBlockIds` + `attachments` → `transactional.emails.update` (`:234-268`); + publish/unpublish (`:278-303`) |
| Saved block editor | `dashboard/mail/blocks/[id]/edit.vue` | `:179-214` **verbatim** | `:219-232` | `:167-175` | `:78-155` | `{ blocks: [...] }` envelope (+ legacy single-block parse `:113-130`) → `emailBlocks.blocks.update` (`:236-268`); **no render** |

Three surfaces. One contract. The first four columns are the same code
three times; the last column is the only thing that genuinely differs —
and it differs two-and-one (the two publishable surfaces share a shape the
Saved block editor does not).

### 1. The `uploadImage` pipeline is copied verbatim three times

All three pages carry the identical ~35-line pipeline: `generateUploadUrl`
→ POST the file → `storage.getUrl` → `getImageDimensions` →
`mediaAssets.create`. It has three error modes (no upload URL, failed
upload, no resulting URL) and one **side effect** that is easy to miss —
every uploaded image is auto-registered to the media library. A small,
deep behaviour hides behind `uploadImage(file) → { url, storageId }`; today
a fix to "what if `mediaAssets.create` fails after the upload succeeded?"
must be made in three places, and a fourth editor surface would copy it a
fourth time.

### 2. The load→dirty→unsaved-changes loop is re-implemented three times

Each page repeats the same machinery: `blocks`/`subject`/`name` refs, the
`isInitialized` "set from server, then start tracking" dance, a deep
change-tracking watch that flips `hasChanges` + `setHasChanges(true)`, and
the `useUnsavedChanges` + `UnsavedChangesDialog` wiring. The loop is
structurally identical; only *which fields it watches* and *how it parses
the row* differ.

### 3. The `savedBlocks` bridge + media-picker plumbing are verbatim three times

`savedBlocks.fetch/save` (calling `emailBlocks.blocks.listByTeam` /
`create`) and the `pickFromMediaLibrary` callback + `showMediaPicker` state
+ `handleMediaPickerSelect` are byte-identical across the three pages —
including the Saved block editor, which provides `savedBlocks` handlers
while itself being the saved-block surface.

### 4. The save divergence splits two-and-one

The Email template and Transactional editors are a sibling pair: both
render HTML, build translations (`useEmailHtmlRendering.
buildHtmlTranslationsForEmail`), derive `linkedBlockIds` from
`savedBlockRef`, and write a publishable lifecycle (ADR-0022 / ADR-0021).
The Saved block editor is the outlier — no HTML, no translations, no
`linkedBlockIds`, no lifecycle, and a different content envelope
(`{ blocks: [...] }` plus a legacy single-block fallback). This fault line
decides the module's shape: it cannot be one config flag, because folding
the outlier in behind a `render: boolean` / `envelope: 'array' | 'wrapper'`
knob is exactly the speculative-knob trap ADR-0001 (considered option 2)
and ADR-0030 (tracking pixels) refused.

### Shared framing

Per LANGUAGE.md's deletion test: deleting one page's binding does not
concentrate complexity — the `uploadImage` pipeline, the dirty loop, and
the `savedBlocks` bridge simply reappear in the next page. *Constructing*
the producer at one location reveals that all three want the same handler
set + the same loop; only `initialize`/`save` diverge. The contract
(`EmailBuilderHandlers`) is already deep for its posture; the producer is
the missing owner. The interface is the test surface: the `uploadImage`
pipeline, `linkedBlockIds` derivation, and dirty-tracking correctness are
reachable today only by mounting a full page against a live Convex client —
none of them has a test.

Confidence: medium-high. Pure frontend refactor — no schema change, no wire
contract change, no backend touch. The `EmailBuilderHandlers` contract and
the lifecycle mutations are unchanged; the three pages keep emitting the
same v-model output and calling the same mutations.

## Decision

Introduce the **Email editor bridge (module)** at
`apps/web/app/composables/useEmailEditorBridge.ts` — the app-side owner
that produces the `EmailBuilderHandlers` and runs the editor's
load→dirty→save loop — plus a **Publishable-email save** helper shared by
the two publishable surfaces. The `CONTEXT.md` `## Email editor` section
(defining both terms) landed inline with the grilling that produced this
ADR.

### Module surface

```ts
// apps/web/app/composables/useEmailEditorBridge.ts (sketch)

interface EmailEditorBridgeOptions<S> {
  source: Ref<S | null | undefined>;       // the loaded row (template / email / block)
  initialize: (source: S) => void;         // per-surface parse → sets blocks/subject/name (+ page refs)
  save: () => Promise<void>;                // per-surface serialize + mutation
  extraWatch?: (() => unknown)[];           // surface-specific dirty-tracked refs (attachments, description)
}

export function useEmailEditorBridge<S>(opts: EmailEditorBridgeOptions<S>): {
  // universal canvas state (v-model into EmailBuilder)
  blocks: Ref<EditorBlock[]>;
  subject: Ref<string>;                     // ignored by the Saved block surface (hideSubject)
  name: Ref<string>;
  isSaving: Ref<boolean>;
  hasChanges: Ref<boolean>;
  // unsaved-changes dialog
  showUnsavedChangesDialog: Ref<boolean>;
  confirmDiscard: () => void;
  confirmSave: () => Promise<void>;
  cancelNavigation: () => void;
  // media picker
  showMediaPicker: Ref<boolean>;
  onMediaPickerSelect: (r: { url: string; storageId?: string }) => void;
  // test-email modal
  showTestEmailModal: Ref<boolean>;
  testEmailHtml: Ref<string>;
  onSendTest: (html: string) => void;
  // the save entrypoint: setSaving → opts.save() → clear dirty
  save: () => Promise<void>;
};
```

The bridge calls `provideEmailBuilderHandlers(...)` itself and acquires its
own `useConvex()` / `useConvexMutation(...)`, so pages stop declaring
`generateUploadUrl`, `createMediaAsset`, and `createEmailBlock` entirely.
The handler set it provides — the `uploadImage` pipeline (with its
media-library side effect), the `savedBlocks` fetch/save, and the
media-picker plumbing — carries **zero config**; it is the verbatim part.

```ts
// apps/web/app/composables/publishableEmailSave.ts (sketch) — emails + transactional only
export async function publishableEmailSave(args: {
  identifier: EmailIdentifier;                 // { emailType, emailId }
  blocks: EditorBlock[];
  renderOptions: RenderOptions;                // theme + variableType
  update: (payload: { htmlContent: string; htmlTranslations: string; linkedBlockIds: string[] }) => Promise<void>;
}): Promise<void>;
```

`publishableEmailSave` is called *inside* each publishable surface's
`save()` closure; it is kept **out** of the bridge so the bridge stays
envelope-agnostic (the Saved block surface renders nothing).

### The kernel/surface split is load-bearing

The split mirrors ADR-0034's pure-core / lenient-conveniences split. The
bridge owns the machinery every surface shares; `initialize` and `save`
are **page-owned closures**, not strategy flags the bridge interprets. The
bridge never branches on which surface it serves — the Saved block
editor's `{ blocks: [...] }` envelope and legacy single-block parse live in
*its* `initialize`, fully visible at the call site, not behind a knob. This
is the rejected-alternative discipline: a single config-driven
`useEmailEditorHost(config)` would force `render`, `translations`,
`envelope`, and `lifecycle` knobs that each pay off in one place.

### Decisions resolved in the grilling

1. **Shape: shared kernel + per-surface save.** Not a config-driven host
   (speculative knobs), not split-by-concern (pages would re-wire three
   composables). The handler set + loop is lifted; `save`/`serialize`
   stays per-surface because it genuinely diverges two-and-one.
2. **`extraWatch`, not `markDirty()`.** All three surfaces' extra
   dirty-tracked fields (`attachments`, `description`) are plain refs, so a
   declarative `extraWatch` list covers them. No surface needs an
   imperative dirty hatch today; adding `markDirty()` now would be the
   speculative seam ADR-0001 warns against. It is trivially added later
   (an `extraWatch` entry is already backed by an internal mark).
3. **Name: "Email editor bridge", not "host".** `CONTEXT.md`'s **Saved
   block consumer** entry already avoids "host" because it reads as
   deployment infrastructure; the same reason applies here. "Bridge" names
   the EmailBuilder↔Convex connection without that connotation.
4. **Lives in `apps/web`.** The handlers depend on the generated
   `@owlat/api`, which `packages/email-builder` cannot import. The
   `EmailBuilderHandlers` contract stays package-side; the producer is
   app-side.

### Replaces

| File | Pre | Post |
|---|---|---|
| `dashboard/emails/[id]/edit.vue` | ~272-line `<script>`: own `uploadImage`/`savedBlocks`/media/loop + `handleSave` | `useEmailEditorBridge({ initialize, save })` where `save` calls `publishableEmailSave`; keeps `variables` + `emailTheme` + template |
| `dashboard/transactional/[id]/edit.vue` | ~351-line `<script>`: same binding + attachments + publish/unpublish + data-variable schema | bridge call with `extraWatch:[attachments]`; `save` calls `publishableEmailSave`; keeps publish/unpublish + `handleCreateVariable` |
| `dashboard/mail/blocks/[id]/edit.vue` | ~285-line `<script>`: same binding + multi-block envelope + settings modal | bridge call with `extraWatch:[description]`; `save` serializes the `{ blocks: [...] }` envelope inline; keeps settings modal |
| — | three copies of the `uploadImage` pipeline, `savedBlocks` bridge, media-picker state, dirty loop | one `useEmailEditorBridge` |
| — | two copies of render + translations + `linkedBlockIds` | one `publishableEmailSave` |

The `EmailBuilderHandlers` contract, `provideEmailBuilderHandlers`,
`useImageUpload`, and `useEmailHtmlRendering` are **unchanged** — the bridge
composes the last of these and feeds the first.

### Folded in vs left out

- **Folded in:** the test-email modal trio
  (`showTestEmailModal`/`testEmailHtml`/`handleSendTest`) is verbatim ×3 →
  bridge-owned.
- **Optional satellite:** `useEmailThemeWithDefaults` (org theme + fallback)
  is identical in the emails + blocks surfaces (transactional passes no
  theme) — a tiny 2-of-3 helper, extractable but not required by this ADR.
- **Out of scope:** the loading / not-found template scaffold duplicated in
  all three `<template>`s is a wrapper-**component** question, not the
  bridge's concern. No backend, lifecycle, or `EmailBuilderHandlers`
  contract change. Threading `@owlat/api` into `packages/email-builder` to
  move the producer package-side is explicitly *not* done.

### Tests

The interface is the test surface. Three new surfaces, all unit-level
against mocked Convex mutations (no page mount):

1. **`uploadImage` pipeline** — the four steps in order, the three error
   modes (missing upload URL, non-ok upload, missing resulting URL), and
   the media-library side effect (`mediaAssets.create` called with measured
   dimensions). Today untestable without a live client.
2. **The load→dirty loop** — `hasChanges` stays false through
   `initialize`, flips on a tracked-ref edit (including `extraWatch`
   entries), and resets after `save()`.
3. **`publishableEmailSave`** — `linkedBlockIds` derived from
   `savedBlockRef` (de-duplicated), and translations assembled for
   supported-minus-default languages, against a mocked renderer.

## Consequences

**The EmailBuilder↔Convex binding lives once.** The `uploadImage`
pipeline (and its media-library side effect), the `savedBlocks` bridge, the
media-picker plumbing, and the dirty/unsaved-changes loop concentrate in
one composable; a fourth editor surface inherits them instead of copying a
fourth time, and a fix to the upload pipeline lands once.

**The save divergence stays honest.** The two publishable surfaces share
`publishableEmailSave`; the Saved block surface shares the bridge but not
the helper, and its odd envelope stays visible in its own `initialize` —
no surface-type branch inside the bridge.

**Three untested-by-construction concerns gain a test surface.** The upload
pipeline, `linkedBlockIds` derivation, and dirty-tracking become pure
functions of injected mutations, testable without mounting a page.

**Surface area:** net negative on app code. ~900 LOC of binding across the
three pages' `<script>` blocks becomes ~3 thin pages + one ~150 LOC bridge
+ one ~40 LOC `publishableEmailSave` + ~150 LOC of new tests.

**Migration:** one PR, frontend-only. No schema migration, no wire-contract
change, every page's v-model output and mutation calls preserved.

1. New `apps/web/app/composables/useEmailEditorBridge.ts`.
2. New `apps/web/app/composables/publishableEmailSave.ts`.
3. Migrate the three editor pages to the bridge; each keeps its own
   `initialize`/`save`, its `variables` source, its theme, and its
   surface-specific UI (publish/unpublish, attachments, settings modal).
4. New tests at `apps/web/app/composables/__tests__/`.
5. `CONTEXT.md` `## Email editor` section (the **Email editor bridge
   (module)** and **Publishable-email save** terms, a Relationships bullet,
   and an Example-dialogue entry) already landed inline with this ADR.

**Risk:** low. Behaviour-preserving by construction — the bridge composes
the existing handler logic and loop verbatim, and the per-surface `save`
closures reproduce each page's current write. The only intended change is
that the three bindings now share one owner.
