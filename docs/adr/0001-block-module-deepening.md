# Block module — per-type vertical encapsulation

**Status:** accepted

## Context

The email renderer dispatches 17 block types (`text`, `image`, `button`,
`columns`, etc.) by switching on `block.type` in seven different places:
HTML render (`blocks/index.ts`), plaintext (`plaintext.ts`), AMP (`amp.ts`),
semantic validation (`validator.ts` + `validators/builtins.ts`), shape
validation (`packages/shared/src/validation/blockSchemas.ts`), compatibility
data (`packages/shared/src/compatibility/data.ts`), and default-content
factories (`packages/email-builder/src/registry/definitions.ts`).

Adding a block type meant editing every one of those files. The block
concept had no module: knowledge about `button` was smeared across the
renderer, builder, validator, and shared packages. The test surface (one
file per cross-cutting switch) did not match the conceptual interface (one
block). Adding the same `case 'button':` to seven files is the deletion
test the existing layout fails.

## Decision

Each block type is a self-contained **Block module** living at
`packages/email-renderer/src/blocks/<type>/`. It exports a `BlockModule<T>`
record containing:

- `type` and `html(args)` — required.
- `placements`, `plaintext`, `amp`, `validate`, `preflight`, `isEmpty`,
  `createDefault`, `compatibility` — optional, with sensible defaults
  supplied by the walker.

The walker dispatches via a typed `ModuleMap = { [T in BlockType]:
BlockModule<T> }`, so a missing registration is a compile error. The
walker — not the block — owns placement-specific wrapping (`wrapSection`,
column-cell, container-cell). Blocks are **placement-blind**: they read
`ctx.allottedWidth` / `ctx.placement` / `ctx.parentEmitsVml` from the
render context but never inspect their parent's identity. This follows
the lesson documented in [MJML issue
#2107](https://github.com/mjmlio/mjml/issues/2107): children-detecting-
parents is brittle; pass layout data down via the context instead.

## Considered options

1. **One method per block, tagged-union ops** (`run({kind:'render-html'|…})`).
   Smallest interface but every caller pays a narrowing tax, and every
   block must `switch` on op kinds from day one — including `divider`.
2. **Capabilities + middleware + `patch()` registry.** Most flexible:
   deployments could swap validators by name and add output formats via
   module augmentation. Rejected because every seam was one-adapter today
   (hypothetical, per LANGUAGE.md). Adding a seam later costs a refactor;
   carrying a speculative seam costs forever.
3. **Optional methods, sensible defaults** (chosen). The common path is
   the cheap path: `divider` is ~20 LOC with no boilerplate. Complex
   blocks fill the optional methods they need. Mapped-type dispatch keeps
   TypeScript honest.

## Consequences

- `registerBlock()` signature breaks: was `(type, renderer)`; now
  `(blockModule)`. Acceptable given nothing is live.
- `packages/shared/src/validation/blockSchemas.ts` is deleted after
  migration; shape validation moves into per-block `validate?`.
- Per-block `createDefault` factories move from
  `packages/email-builder/src/registry/definitions.ts` into block modules.
- The cross-cutting switches in `plaintext.ts`, `amp.ts`, `validator.ts`,
  and `blocks/index.ts` collapse to thin walkers that dispatch to the
  registry.
- The existing `validators/registry.ts` `BlockValidator` interface is
  superseded by the `validate?` method on `BlockModule`; the registry
  collapses into the same dispatch.
- New block types require touching exactly one folder. Tests for that
  block co-locate at `blocks/<type>/__tests__/`.

## Follow-up work

The full migration is structurally complete: HTML, plaintext, AMP, placement
metadata, empty-block checks, render-time warnings, validation,
`createDefault`, and per-block compatibility data all live in Block modules.
The three consolidations that were originally scoped as follow-up PRs are
all done:

1. **Validation consolidation — done.** Each block module's `validate?`
   method combines shape, semantic, and Outlook-specific validation.
   `registerBlockModule()` bridges `validate?` into the legacy
   `BlockValidator` registry. `packages/shared/src/validation/blockSchemas.ts`
   was reduced to the `ValidationIssue` type only;
   `packages/email-renderer/src/validators/builtins.ts` is gone.

2. **`createDefault` migration — done.** Each block module's `createDefault?`
   returns block-specific content (no padding/margin). The email-builder
   registry at `packages/email-builder/src/registry/definitions.ts` delegates
   to `moduleFor(type).createDefault!(theme)` and wraps with universal
   `defaultPadding` / `defaultMargin`.

3. **Compatibility consolidation — done.** Each block module's
   `compatibility?: { features?, properties? }` field carries the per-block
   Feature compatibility and Property compatibility entries. The
   Compatibility walker at `packages/email-renderer/src/compatibility/`
   collects from registered modules and drives scoring, audience-reach math,
   and the builder-UI limitation summaries. `PropertyCompatibility` lost its
   `blockType` field — implied by the owning module. The dead caniemail
   runtime path (`fetchCanIEmailData`, `generateBlockCompatibility`,
   `featureToBlockMapping`) and `owlatAnnotations` side-table were deleted
   in the same pass since neither had any callers. `@owlat/shared` retains
   the types, the plugin extension registries, and the static client
   metadata; everything per-block lives in the renderer next to the modules.

4. **Walker leak cleanup — done.** Four residual `block.type === 'X'` checks
   in the Walker were absorbed into per-module hooks (Option β shape):
   - `BlockModule.layout?(content)` returns
     `{ background?, padding?, sectionMode? }`. `button` overrides
     `background` (it stores section bg on `blockBackgroundColor` because
     `backgroundColor` is the button's fill). `hero` returns
     `sectionMode: 'outer-only'` so its full-bleed bg flows to the section
     edges instead of being inset by the padding sum. `helpers/padding.ts`
     and `helpers/table.ts` no longer switch on `block.type`.
   - `BlockModule.applyTheme?(content, theme)` owns per-type theme-default
     consumption. `text` reads `theme.headingDefaults[h1|h2|h3]` and
     `theme.bodyFontSize`/`bodyTextColor`. `button` reads
     `theme.buttonDefaults`. `applyThemeDefaults` in `renderer.ts` is now a
     two-step Walker (module hook, then universal `blockDefaults[type]`
     merge) with no per-type branches.
   - `BlockModule.responsiveCss?(args)` returns CSS rules pushed onto
     `ctx.responsiveRules` during dispatch. `text` emits the mobile-font-
     size rule. The pre-render `collectMobileFontRules` sweep is gone.

5. **Editor module — done.** The Block module is now physically split: the
   render half stays at `packages/email-renderer/src/blocks/<type>/`, and a
   new editor half lives at `packages/email-builder/src/blocks/<type>/`,
   each exporting an `EditorModule<T>`. The editor module owns label, icon,
   panel schema (re-exported from `schema/definitions/`), slash-menu entry,
   capability flags, column-context default factory, and (for composite
   blocks) `childrenView()` and `allowedChildTypes()`.
   `packages/email-builder/src/registry/definitions.ts` is deleted — its 18
   `registerBlock({...})` calls became 17 self-registering module files
   under `blocks/<type>/`. The legacy `BlockDefinition` API in
   `registry/blockRegistry.ts` is preserved for back-compat but is now a
   thin bridge over the typed `EditorModuleMap`.
   `panel/NestedItemsEditor.vue` no longer switches on
   `columns`/`container`/`hero`/`accordion` — it dispatches to
   `editorModuleFor(type).childrenView?.(block)` and
   `.allowedChildTypes?.()`. Adding a new block type now requires touching
   two folders (renderer + editor) and the `BlockType` union.
