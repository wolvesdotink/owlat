# ADR-0044 — execution plan for ADR-0004 (automation modules)

> Companion execution plan for [ADR-0004](./0004-automation-modules.md).
> Renumbered from `0004-execution-plan.md` to its own unique ADR number so the
> `000X` prefix is unambiguous (one document per number).

Phased migration for the automation modules ADR. Each phase is one shippable
PR. Existing tests pass at every phase boundary; behavior is unchanged until
the phase that explicitly migrates a wire path.

## Order rationale

**Triggers first.** The duplication is the largest in the domain (five fire
mutations + one inline sixth copy, ~200 LOC of ceremony), and the trigger
boundary has the smallest dependency surface — triggers do not depend on
steps or conditions. Lands the **Trigger fanout** vocabulary and proves the
module-family pattern in this domain with the lowest blast radius.

**Steps (email, delay) before condition step.** The condition step's
`execute` consumes a condition type module, so it cannot land until the
conditions phase. Email and delay are pure step modules with no
cross-family dependency.

**Conditions before the condition step migration.** The condition type
module family + the segment-evaluator migration land together. The
automation `condition` step keeps running on the legacy path until that
phase finishes, then migrates in the next phase.

**Frontend last.** Backend stability first; the editor migration is a
mechanical follow-up once `StepModule.kind` and the canonical `Condition`
shape are settled.

---

## Phase 1 — Foundation (no behavior change)

**Changes**

- `automations/types.ts` — `StepModule`, `StepOutcome`, `TriggerModule`,
  `ConditionTypeModule` interfaces; empty `StepModuleMap`,
  `TriggerModuleMap`, `ConditionTypeModuleMap`.
- `automations/steps/index.ts`, `automations/triggers/index.ts`,
  `conditions/index.ts` — empty dispatcher skeletons.
- `CONTEXT.md` — add the **Automations** domain section with the seven
  new terms. Update the Relationships section.

**Tests**

- Type-only assertions that the module maps are exhaustive once every
  registration lands.

**Done when** — new files compile, types resolve, no runtime changes.

---

## Phase 2 — Trigger fanout

**Changes**

- `automations/triggers/contact_created/index.ts`,
  `automations/triggers/contact_updated/index.ts`,
  `automations/triggers/event_received/index.ts`,
  `automations/triggers/topic_subscribed/index.ts` — one
  `TriggerModule` per kind, exporting `matches` + `buildTriggerData`.
- `automations/triggers/index.ts:fireTrigger(ctx, kind, input)` — the
  **Trigger fanout** walker owning the 40-line ceremony exactly once.
- `automations/triggers.ts` — the four `fire*Trigger` mutations collapse
  to one-line wrappers around `fireTrigger`. The inline sixth copy in
  `sendEvent` is removed; `sendEvent` calls `fireTrigger('event_received',
  …)` directly.
- `lib/automationConfigTypes.ts` — `isContactUpdatedTrigger`,
  `isEventReceivedTrigger`, `isTopicSubscribedTrigger` deleted; each
  module's `parseConfig` supersedes them.

**Tests**

- `automations/triggers/<kind>/__tests__/index.test.ts` — `matches`
  truth-table per kind, `buildTriggerData` shape.
- `automations/triggers/__tests__/fireTrigger.test.ts` — ceremony
  invariants (skip-if-in-progress, skip-if-no-steps, stats patch,
  scheduler call).
- Existing trigger integration tests pass unchanged.

**Done when** — every fire path goes through `fireTrigger`; the four
public mutations are one-liners; `rg 'fireContactCreatedTrigger|fireContactUpdatedTrigger|fireEventReceivedTrigger|fireTopicSubscribedTrigger'`
returns only the new wrapper lines.

---

## Phase 3 — Step walker, non-condition steps

**Changes**

- `automations/steps/email/index.ts`,
  `automations/steps/delay/index.ts` — `StepModule` per kind, exporting
  `parseConfig`, `execute`, and (for delay) `entryDelay`.
- `automations/stepExecutor.ts` renamed to
  `automations/stepWalker.ts`. The walker dispatches via `StepModuleMap`
  for `email` and `delay`; the `condition` branch stays on the legacy
  open-coded path until phase 5. The three look-ahead-delay sites
  collapse to one `module.entryDelay?.(config) ?? 0` lookup.
- `automations/steps/index.ts:stepModuleFor()` — registry dispatcher.
- `lib/automationConfigTypes.ts` — `isEmailConfig`, `isDelayConfig`
  deleted.

**Tests**

- `automations/steps/email/__tests__/`,
  `automations/steps/delay/__tests__/` — per-module unit tests for
  `execute` (email template lookup, personalization, send) and
  `entryDelay` (unit conversion).
- `automations/__tests__/stepWalker.test.ts` — walker invariants
  (retries, marks executing/completed/failed, advances sequentially).
- Existing automation integration tests pass.

**Done when** — `step.stepType === 'email'` and
`step.stepType === 'delay'` switches are gone from the walker;
`step.stepType === 'condition'` is the only remaining branch.

---

## Phase 4 — Condition type modules + segment evaluator migration

**Changes**

- `conditions/contact_property/index.ts`,
  `conditions/email_activity/index.ts`,
  `conditions/topic_membership/index.ts` — `ConditionTypeModule` per
  kind, exporting `parseCondition`, `preloadLookup`, `evaluate`. The
  per-kind operator logic lives inside each module.
- `conditions/index.ts:evaluateConditions(ctx, conditions, contact)`
  walker — the cross-family helper used by both segment evaluator and
  the eventual condition step module.
- `lib/segmentEvaluation.ts` — `evaluateOperator`,
  `buildConditionLookups`, `evaluateConditionWithLookup`,
  `evaluateCondition` collapse to thin dispatchers through
  `conditions/index.ts`. `evaluateSegmentCount` and
  `evaluateMultipleSegments` keep their public signature but route
  per-condition work through the modules.
- **Schema migration** — Convex internal mutation
  `migrations/0004_condition_kind.ts` walks `segments.filters` rows and
  rewrites `condition.type` → `condition.kind`. (Automation step
  condition rows migrate in phase 5 alongside the condition step
  module landing, since both happen atomically.)

**Tests**

- `conditions/<kind>/__tests__/index.test.ts` — `evaluate` truth-table
  per kind, `preloadLookup` correctness (batch + single-item).
- `lib/__tests__/segmentEvaluation.test.ts` — fixtures rewritten to
  canonical shape; behavioral assertions unchanged.

**Done when** — `lib/segmentEvaluation.ts` no longer contains any
`condition.type === 'X'` or operator switches; segment behavior is
byte-identical.

---

## Phase 5 — Condition step module + automation schema migration

**Changes**

- `automations/steps/condition/index.ts` — `StepModule` for `condition`.
  `execute` calls
  `conditionTypeModuleFor(config.condition.kind).preloadLookup([config.condition])`
  then `evaluate`, branches on the result to set `nextStepIndex`
  (`yesBranchStepIndex` / `noBranchStepIndex`).
- `automations/stepWalker.ts` — the `condition` branch in the walker
  collapses; the walker is now switch-free over `step.kind`.
- `lib/automationConfigTypes.ts` — `isConditionConfig` deleted; the
  file is type-aliases-only.
- **Schema migration** — extension of `migrations/0004_condition_kind.ts`
  rewrites `automationSteps.config` rows where `stepType === 'condition'`:
  - `propertyKey → field`, `value` stays, `operator` renamed
    (`greater_than → gt`, `less_than → lt`, `is_set → not_empty`,
    `is_not_set → is_empty`).
  - `emailActivity` field expands to `{field, operator}`
    (`opened → {field: 'opened', operator: 'is_true'}`,
    `not_opened → {field: 'opened', operator: 'is_false'}`, etc.).
  - Wraps the condition under a `condition` key; lifts
    `yesBranchStepIndex` / `noBranchStepIndex` to the top level.

**Tests**

- `automations/steps/condition/__tests__/index.test.ts` — `execute`
  paths per condition kind, branching behavior (yes/no/sequential),
  missing-condition-module error case.
- Integration tests for end-to-end automation runs through condition
  steps stay green.

**Done when** — `automations/stepWalker.ts` contains no `step.kind ===
'X'` branches; `migrations/0004_condition_kind.ts` is idempotent; every
condition-step automation runs identically post-migration.

---

## Phase 6 — Editor modules (frontend)

**Changes**

- `composables/automations/steps/email/index.ts`,
  `composables/automations/steps/delay/index.ts`,
  `composables/automations/steps/condition/index.ts` —
  `StepEditorModule` per kind, exporting `createDefault`,
  `validateForActivation`, `getDescription`, `EditorComponent`.
- `composables/automations/triggers/<kind>/index.ts` × 4 —
  `TriggerEditorModule` per kind.
- `composables/conditions/<kind>/index.ts` × 3 — **Condition editor
  module** per kind (label, description, `createDefault(ctx)`,
  `validateForSubmit`, `getDescription(condition, ctx)`,
  `EditorComponent` accepting `variant: 'row' | 'panel'`). Lives at
  the *shared* `composables/conditions/<kind>/` location — not under
  `composables/automations/` — because both the segment filter editor
  (`segments/index.vue` via `useSegmentFilters`) and the automation
  condition step's settings panel render the same `EditorComponent`,
  differing only by the `variant` prop. CONTEXT.md "Condition editor
  module" and "Condition editor context" pin the vocabulary; the home
  was decided in the architecture-deepening session that surfaced the
  segment-vs-automation duplication the original phase-6 plan would
  have shipped.
- `composables/conditions/useConditionEditorContext.ts` — the
  inject-keyed reference-data composable (`contactProperties`,
  `topics`). Provided by each top-level consumer (segment modal,
  automation step panel); injected by Condition editor modules.
- `components/automations/steps/<kind>/Editor.vue` × 3,
  `components/automations/triggers/<kind>/Editor.vue` × 3 (no editor
  for `contact_created`), `components/conditions/<kind>/Editor.vue` × 3 —
  the actual Vue settings panels. The condition `Editor.vue`s sit
  under `components/conditions/<kind>/`, matching the shared module
  location.
- `composables/automations/steps/condition/index.ts`'s
  `EditorComponent` becomes a thin wrapper: a panel that renders
  `<ConditionEditor variant="panel" v-model="config.condition" />` plus
  the yes/no branch-step selectors. It owns the step-flow concerns
  (branch indices) and delegates the condition picker entirely to the
  shared Condition editor module.
- **Segment editor cleanup (in this phase, not deferred).**
  `composables/useSegmentFilters.ts` (222 LOC) collapses to ~30 LOC:
  iterate `CONDITION_EDITOR_MODULES` for the kind picker, dispatch to
  the per-kind module for validation/description, no `getOperatorsForType`
  switch, no `filterTypes`/`emailActivityFields`/`builtInFields` arrays.
  `composables/useSegmentForm.ts:102–124` per-kind validation messages
  collapse to a single walk calling `module.validateForSubmit`.
  `pages/dashboard/audience/segments/index.vue:430–552` three
  `v-if="condition.type === 'X'"` blocks collapse to
  `<component :is="conditionEditorModuleFor(condition.kind).EditorComponent" variant="row" v-model="condition" />`.
  The orphan `'subscription'` filter-type literal in
  `useSegmentFilters.ts:66,102` is deleted (FE-only; no backend kind;
  rejected on save by the post-phase-4 validator). The
  `condition.type` → `condition.kind` FE drift bug is closed here —
  the segment editor stops writing `.type` to a shape the backend
  validates as `.kind`.
- `useAutomationStepConfig.ts` — collapse from 178 LOC to ~40. The 15
  flat refs become one typed `currentConfig: Ref<C>` keyed by the
  editor module.
- `useAutomationSteps.ts` — three description helpers, `canActivate`,
  `handleAddStep` defaults switch all dispatch through editor modules.
  The `stepTypes` array is replaced by iterating the
  `StepEditorModuleMap` keys.

**Tests**

- Per-step-editor-module unit tests for `validateForActivation`,
  `getDescription`, `createDefault`.
- Per-Condition-editor-module component tests at
  `composables/conditions/<kind>/__tests__/Editor.test.ts` × 3 — mount
  each kind's `EditorComponent` in both `variant: 'row'` and
  `variant: 'panel'` modes, fill the form, assert `v-model` emits a
  value satisfying the canonical `ConditionOfKind<K>` shape, assert
  `validateForSubmit` returns the expected message for each failure
  mode. Provide a stub Condition editor context so the modules' inject
  resolves.
- Component tests for each step / trigger `EditorComponent` confirming
  `modelValue` round-trips through the form.
- Existing `useAutomationStepConfig` / `useAutomationSteps` tests
  re-target the module-based API.
- Existing `useSegmentFilters` / `useSegmentForm` tests re-target the
  Condition editor module registry — the per-kind branches in those
  composables are gone, so the tests assert dispatch behavior instead.

**Done when** — `useAutomationStepConfig.ts` and `useAutomationSteps.ts`
contain zero `step.stepType === 'X'` switches; `useSegmentFilters.ts`
contains zero `condition.type === 'X'` switches; adding a new step
kind requires touching exactly two folders (backend + frontend) plus
the `StepKind` union; adding a new Condition kind requires touching
exactly two folders (backend `conditions/<kind>/` + frontend
`composables/conditions/<kind>/`) plus the `ConditionKind` union, and
*both* the segment editor and the automation condition step's panel
pick it up via the registry with no further edits.

---

## Phase 7 — Cleanup + drift verification

**Changes (landed)**

- `lib/automationConfigTypes.ts` collapsed to validator-derived type
  aliases only. The six `is*Config` / `is*Trigger` type guards were
  deleted.
- `useAutomationSteps.ts`'s hand-maintained `stepTypes` array became a
  computed derived from `listStepEditorModules()` (landed in Phase 6).
- `lib/segmentEvaluation.ts` had no remaining legacy operator switch
  by Phase 4 — verified clean.
- Frontend trigger editor module gains `getSummary(config, ctx) →
  string`; the trigger summary in `[id]/edit.vue` collapses from a
  three-branch ternary over `triggerType`+casts to one
  `triggerEditorModuleFor(kind).getSummary(config, { topics })` call.
- Step icon/label display in `[id]/edit.vue` and `[id]/index.vue`
  routes through `stepEditorModuleFor(stepType).icon` / `.label`
  instead of `stepType === 'email' ? 'lucide:mail' : …` chains.
- Page-local accent palettes (the per-step background tint that varies
  per consumer page — the funnel page uses warning/brand/text-tertiary,
  the edit page uses brand/warning) collapse to frozen
  `Record<StepKind, Accent>` objects indexed by `stepType` instead of
  `stepType === 'X' ? … : …` ternaries.
- Backend `StepModule<T, C>` gains an optional `enrichForQuery(ctx,
  config)` hook so `getWithRelations` dispatches email-template joins
  through the email step module instead of an inline `if (step.stepType
  === 'email')` check. A new `enrichStepForQuery(ctx, step)` walker in
  `automations/steps.ts` is the single call site.
- Backend `TriggerModule<T, C, FireInput>` gains the same
  `enrichForQuery(ctx, config)` hook; the topic_subscribed trigger
  module implements it (joins the topic doc); a new
  `enrichTriggerForQuery(ctx, triggerType, triggerConfig)` walker in
  `automations/triggers.ts` is the single call site. The
  `getWithRelations` query is now switch-free over both `stepType` and
  `triggerType`.

**Verification (landed state)**

- `rg "step\.stepType === '"` — zero hits outside the Step walker and
  per-step modules. ✅
- `rg "condition\.type === '"` and `rg "condition\.kind === '"` —
  zero hits outside the conditions registry (backend) and the
  Condition editor module registry (frontend). ✅
- `rg "triggerConfig as "` — zero hits outside trigger-module
  `parseConfig` implementations. ✅
- `rg "'subscription'"` in `useSegmentFilters` / `useSegmentForm` —
  zero hits; the orphan FE-only filter type is gone. ✅
- All four Phase 7 verification greps return zero hits across both
  `apps/api/convex/` and `apps/web/app/`. ✅

**Tests** — Full test suite green; `vue-tsc` and `tsc -p convex/tsconfig.json`
both clean.

**Done when** — editor knowledge (label, icon, default factory,
validation, description, EditorComponent) lives exclusively in the per-
kind modules; remaining `stepType ===` reads are either backend
discriminators (legitimate) or page-local UX styling (the funnel
display uses different colors than the edit page). CONTEXT.md
vocabulary matches the code.

---

## Phase summary

| Phase | What | Wire-visible risk |
|---|---|---|
| 1 | Foundation types + CONTEXT.md | None |
| 2 | Trigger fanout | Low (internal API; pre-prod) |
| 3 | Step walker (email + delay) | Low |
| 4 | Condition modules + segment migration | Medium (schema migration on segments.filters) |
| 5 | Condition step + automation schema migration | Medium (schema migration on automationSteps.config) |
| 6 | Editor modules (step + trigger + shared Condition editor module; segment editor rewires onto the shared registry) | Low (frontend rewire — closes the FE `condition.type` ↔ backend `condition.kind` drift bug that exists between phases 4 and 6) |
| 7 | Cleanup | None |

Estimated 7 PRs.

## Verification checkpoints

- After phase 2: every existing trigger integration test passes;
  trigger duplication is gone (`rg "fire.*Trigger"` shows only one
  walker plus thin wrappers).
- After phase 4: segment count math is byte-identical pre/post
  migration on a fixture corpus.
- After phase 5: every running automation continues from its current
  step correctly; condition steps branch identically on the new shape.
- After phase 7: `rg "step\\.stepType === '"`, `rg "condition\\.type === '"`,
  and `rg "config\\.conditionType ==="` all return no hits outside the
  module registries.
