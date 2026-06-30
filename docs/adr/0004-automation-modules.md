# Automation modules — step + trigger + shared condition types

**Status:** accepted

## Context

The `apps/api/convex/automations/` domain has three cross-cutting kinds whose
literals are pattern-matched at every consumer, with zero module-keyed
dispatch.

### Step types

`'email' | 'delay' | 'condition'` is switched on in at least eight places:

- `stepExecutor.ts:executeStep` — main handler chain (lines 390–437) selecting
  per-type execution logic, then a *second* nested switch inside
  `evaluateCondition` on `config.conditionType` (lines 100–148).
- Look-ahead scheduling delay — `if (nextStep.stepType === 'delay')` appears
  in three places (`advanceToStep`:186–190, the main handler:468–471, and
  `startAutomationRun`:588–599). Three copies of the same look-ahead.
- `useAutomationStepConfig.ts` — two parallel switches: one populating 15
  flat refs from `step.config` (73–91), one rebuilding `step.config` from
  refs (108–136). Adding a step kind means editing both.
- `useAutomationSteps.ts` — three sibling description helpers
  (`getEmailTemplateName` / `getDelayDescription` / `getConditionDescription`),
  a `handleAddStep` config-defaults switch (165–181), a `canActivate`
  per-kind validation switch (249–265), and a half-built `stepTypes` array
  (44–63) that is a registry pretending to be a list.

The type guards `isEmailConfig` / `isDelayConfig` / `isConditionConfig` in
`lib/automationConfigTypes.ts` exist precisely because there is no
module-keyed dispatch — they are the prosthesis for the missing seam.

### Trigger types

Five nearly-identical fire mutations in `automations/triggers.ts`:

- `fireContactCreatedTrigger` (lines 125–193)
- `fireContactUpdatedTrigger` (lines 197–276)
- `fireEventReceivedTrigger` (lines 280–364)
- `fireTopicSubscribedTrigger` (lines 367–447)
- A sixth inline copy at `sendEvent` (lines 529–604)

Each does: query active automations by `(status, triggerType)` → loop →
narrow `triggerConfig` → call a per-type matching predicate → skip if
contact already in a running run → skip if no steps → insert `automationRuns`
row → patch `statsEntered` / `statsActive` → schedule the step executor.
The matching predicate is one to three lines; the ceremony around it is
~40 lines copied six times.

### Condition shapes

`stepExecutor.ts:evaluateCondition` and
`lib/segmentEvaluation.ts:evaluateConditionWithLookup` both dispatch on a
condition-type literal and both implement an operator switch. They share
neither code nor schema:

| Concept | Segment schema | Automation schema |
|---|---|---|
| Property name | `condition.field` | `config.propertyKey` |
| Property comparison value | `condition.value` | `config.value` |
| Email activity selector | `field='opened' + operator='is_true'` | `emailActivity='opened'` |
| Greater than | `gt` | `greater_than` |
| Is set / not empty | `not_empty` | `is_set` |

Two implementations of the same semantics with different wire shapes. Adding
a new operator or condition type means editing both files; renaming an
operator means renaming the wrong one twice.

### Shared framing

The four-way smear (step executor + step editor + trigger fanout + segment
evaluator) all has the same shape: an open switch over a literal kind, with
per-kind logic inlined and no per-kind module. Per ADR-0001 and ADR-0003,
this is the canonical shape for *Block module-style* deepening.

## Decision

Four module families with parallel structure to the existing Block module
(ADR-0001) and Webhook event module (ADR-0003) work.

### Step module (executor half)

`apps/api/convex/automations/steps/<kind>/index.ts` exports:

```ts
interface StepModule<T extends StepKind, C> {
  kind: T;
  parseConfig(raw: unknown): C;
  entryDelay?(config: C): number;   // ms — only `delay` implements
  execute(ctx: ActionCtx, args: {
    config: C;
    contact: Doc<'contacts'>;
    automation: Doc<'automations'>;
    stepRunId: Id<'automationStepRuns'>;
  }): Promise<StepOutcome>;
}

type StepOutcome =
  | { status: 'completed'; emailSendId?: string; nextStepIndex?: number }
  | { status: 'failed'; error: string };
```

`nextStepIndex` overrides the walker's default `current + 1`. Only the
`condition` step uses it (for branching). `entryDelay` is the walker's
look-ahead hook — only `delay` implements it; everyone else takes the
default of 0 and the walker schedules immediately.

The walker (the renamed `stepExecutor.ts` → conceptually the **Step walker**)
dispatches via a typed `StepModuleMap = { [K in StepKind]: StepModule<K, ...> }`
so a missing registration is a compile error. The walker owns:

- Run state lookup, status checks, retry policy (3 retries, exponential).
- Marking step runs executing / completed / failed.
- Sequential advance (`current + 1`) unless the module returns
  `nextStepIndex`.
- Asking the *next* module for its `entryDelay` and scheduling accordingly.

The walker never inspects `step.kind` directly.

### Step editor module (editor half)

`apps/web/app/composables/automations/steps/<kind>/index.ts` exports:

```ts
interface StepEditorModule<T extends StepKind, C> {
  kind: T;
  label: string;
  description: string;
  color: string;
  createDefault(): C;
  validateForActivation(config: C): string | null;
  getDescription(config: C, ctx: DisplayCtx): string;
  EditorComponent: Component<{
    modelValue: C;
    'onUpdate:modelValue': (c: C) => void;
  }>;
}
```

Discriminated state: `useAutomationStepConfig` exposes one typed
`currentConfig: Ref<C>` keyed by the selected step's `kind`. The 15 flat
refs collapse. Templates dispatch via
`<component :is="module.EditorComponent" v-model="currentConfig" />` — no
per-kind `v-if` chain.

`useAutomationSteps`' three description helpers, `canActivate` validation
switch, and `handleAddStep` defaults switch all dispatch through the editor
module: `module.getDescription(config)`,
`module.validateForActivation(config)`, `module.createDefault()`.

### Trigger module (firing half)

`apps/api/convex/automations/triggers/<kind>/index.ts` exports:

```ts
interface TriggerModule<T extends TriggerKind, C, FireInput> {
  kind: T;
  parseConfig?(raw: unknown): C | null;  // omitted for contact_created
  matches(input: FireInput, config: C | null): boolean;
  buildTriggerData?(input: FireInput, config: C | null): TriggerData;
}
```

The five fire mutations + the sixth inline copy collapse to one walker
`fireTrigger(ctx, kind, input)` (the **Trigger fanout**) that owns the
~40-line ceremony exactly once. Callers pass a typed `input`; the walker
looks up the module, evaluates `matches` per active automation, and
performs the ceremony.

### Trigger editor module

`apps/web/app/composables/automations/triggers/<kind>/index.ts` exports the
same shape as the step editor module, minus `EditorComponent` for trigger
kinds with no config (`contact_created`).

### Condition type module (shared between segments and automations)

`apps/api/convex/conditions/<kind>/index.ts` exports:

```ts
interface ConditionTypeModule<T extends ConditionKind, C, Lookup> {
  kind: T;
  parseCondition(raw: unknown): C;
  preloadLookup(ctx: DatabaseReader, conditions: C[]): Promise<Lookup>;
  evaluate(condition: C, contact: Doc<'contacts'>, lookup: Lookup): boolean;
}
```

Single batch path. The segment evaluator preloads all conditions for one
segment at once; the automation condition step preloads `[condition]` for
one and evaluates against one contact. Operators live *inside* the
per-kind module — no global operator switch. `contact_property` carries
the full operator set; `email_activity` carries only `is_true / is_false`;
`topic_membership` carries only `equals / not_equals`.

The canonical `Condition` shape:

```ts
type Condition =
  | { kind: 'contact_property'; field: string; operator: PropertyOp; value: string }
  | { kind: 'email_activity'; field: 'opened' | 'clicked'; operator: 'is_true' | 'is_false' }
  | { kind: 'topic_membership'; topicId: Id<'topics'>; operator: 'equals' | 'not_equals' };

type PropertyOp =
  | 'equals' | 'not_equals' | 'contains' | 'not_contains'
  | 'gt' | 'lt' | 'gte' | 'lte'
  | 'is_empty' | 'not_empty';
```

The segment shape wins as canonical — more mature vocabulary and the
segments table is the higher-volume of the two. Automation step
configurations migrate field names and operator names accordingly; the
discriminator is renamed `type → kind` on both sides for parity with
Block module and Webhook event module discriminators.

The automation `condition` step's persisted config flattens: instead of
embedding condition fields directly, it wraps a `Condition` plus the
branching state. The branching state stays outside the condition because
it is a step-flow concern, not a condition concern:

```ts
type ConditionStepConfig = {
  condition: Condition;
  yesBranchStepIndex: number | null;
  noBranchStepIndex: number | null;
};
```

### Dispatch summary

| Concept | Walker location | Dispatches on | Module location |
|---|---|---|---|
| Step | `automations/stepWalker.ts` | `step.kind` | `automations/steps/<kind>/` |
| Step editor | `composables/automations/useAutomationStepConfig.ts` | `step.kind` | `composables/automations/steps/<kind>/` |
| Trigger | `automations/triggers/index.ts:fireTrigger` | `triggerKind` arg | `automations/triggers/<kind>/` |
| Condition (eval) | `conditions/index.ts:evaluateConditions` | `condition.kind` | `conditions/<kind>/` |

The condition step is itself a step module that *consumes* a condition type
module: inside `automations/steps/condition/index.ts:execute`, it calls
`conditionTypeModuleFor(config.condition.kind).preloadLookup` then
`evaluate`. No separate `conditionType` literal at the step layer — the
condition's `kind` is the dispatch key.

## Considered options

Forks debated in the design conversation:

1. **Scope.** Steps only vs. steps + triggers in one pass. Picked
   steps + triggers — the parallel module-family pattern locks in together,
   the CONTEXT.md update happens once, and the trigger duplication win
   (~200 LOC across five mutations + one inline copy) is the largest in
   the area.
2. **Condition unification.** Per-domain modules vs. one shared
   `ConditionTypeModule` family. Picked unification: the segment-vs-
   automation duplication was the most-egregious case in the candidate
   list, and pre-prod schema migration is cheap. Sub-option A1 (canonical
   = segment shape) chosen over A2 (canonical = automation shape) because
   the segment vocabulary is older and the segments table is larger.
3. **Editor state shape.** Flat-bag-of-refs vs. composables-per-module
   vs. one discriminated config. Picked the discriminated config +
   per-module `EditorComponent`: matches the Block module editor half and
   removes the `useAutomationStepConfig` ↔ template coupling entirely.
4. **Look-ahead delay.** Generic `entryDelay?` hook vs. walker still
   knowing that `delay` is special. Picked generic: removes the last
   `if (kind === 'delay')` and generalizes to future
   `wait_for_event`-style steps without a refactor.
5. **Condition step config shape.** Wrap a condition reference inside a
   step config vs. flatten so the step config *is* the condition + branch
   indices. Picked the flatten: pre-prod, schema migration is free;
   removes one indirection; the persisted shape is the same one segments
   use.
6. **Trigger consolidation depth.** Five typed wrapper mutations vs. one
   generic `fireTrigger`. Picked the latter: callers are all internal,
   pre-prod, and the wrapper mutations were thin shells around the
   ceremony.
7. **Walker naming.** Reuse the **Walker** vocabulary from ADR-0001 for
   step dispatch and the **Fanout** vocabulary from ADR-0003 for trigger
   fan-out. Keeps cross-domain terminology consistent.

## Consequences

### Files that collapse / disappear

- `automations/triggers.ts` shrinks from 605 LOC: five fire mutations +
  the inline copy in `sendEvent` collapse to one `fireTrigger` walker
  plus per-kind module records. The `isContactUpdatedTrigger` /
  `isEventReceivedTrigger` / `isTopicSubscribedTrigger` type guards in
  `lib/automationConfigTypes.ts` disappear — each module's `parseConfig`
  supersedes them.
- `automations/stepExecutor.ts` shrinks dramatically: the per-kind `if`
  chain in `executeStep`, the three copies of look-ahead delay, the
  `evaluateCondition` switch, and the `executeEmailStep` helper all move
  into per-kind modules. The file is renamed `stepWalker.ts`.
- `lib/automationConfigTypes.ts` shrinks to type aliases derived from
  the module map.
- `useAutomationStepConfig.ts` shrinks from 178 LOC: the 15 flat refs +
  two switches collapse to one typed `currentConfig: Ref<C>` keyed by
  the editor module.
- `useAutomationSteps.ts`: three description helpers, the `canActivate`
  per-kind validation, and the `handleAddStep` defaults switch all
  become single dispatches through editor modules.
- `lib/segmentEvaluation.ts:evaluateOperator`, `buildConditionLookups`,
  `evaluateConditionWithLookup`, and `evaluateCondition` all collapse to
  thin dispatchers through `conditions/index.ts`. The per-condition-type
  logic lives in the modules.

### Files that grow

- `automations/steps/<email | delay | condition>/index.ts` × 3 (new;
  each ~50–120 LOC).
- `automations/triggers/<contact_created | contact_updated | event_received | topic_subscribed>/index.ts` × 4
  (new; each ~20–60 LOC).
- `conditions/<contact_property | email_activity | topic_membership>/index.ts` × 3
  (new; each ~50–120 LOC; the most logic-dense).
- Editor-side per-kind modules + Vue components mirror the renderer
  side in `composables/automations/` and `components/automations/`.

### Schema migration (pre-prod, breaking)

- `segments.filters` rows: `condition.type` → `condition.kind` (no value
  changes for shape; field/operator vocabulary already canonical).
- `automationSteps.config` rows where `stepType === 'condition'`:
  rewrite to
  `{condition: {kind, field|topicId, operator, value}, yesBranchStepIndex, noBranchStepIndex}`.
  Map `propertyKey → field`, `greater_than → gt`, `less_than → lt`,
  `is_set → not_empty`, `is_not_set → is_empty`. Map the singleton
  `emailActivity` field to `{field, operator}` per the canonical shape.

No data-loss risk; backfill is one Convex internal mutation that walks
both tables and rewrites rows in place. Pre-prod, no shadow window
needed.

### Test surface

- Per-module unit tests at `<family>/<kind>/__tests__/`. Each step module
  tests `execute` and `entryDelay`; each trigger module tests `matches`
  and `buildTriggerData`; each condition type module tests `preloadLookup`
  + `evaluate` for both segment-style batch and condition-step single-item
  call patterns.
- Existing `automations/__tests__/` integration tests stay, asserting
  end-to-end behavior through the walker — the walker becomes the test
  surface, not the per-kind branches.
- Segment evaluation tests get re-fixtured for the canonical shape but
  keep their behavioral assertions.

### Vocabulary

CONTEXT.md gains an **Automations** domain section. Seven new terms —
**Step module**, **Step walker**, **Step outcome**, **Trigger module**,
**Trigger fanout**, **Condition type module**, **Condition** — pin the
language used in this ADR.

## Follow-up work

Execution plan in `docs/adr/0044-execution-plan.md` (Order 2: triggers →
steps → conditions, per the design conversation).
