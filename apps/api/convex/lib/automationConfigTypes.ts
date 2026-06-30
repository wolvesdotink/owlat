import type { Infer } from 'convex/values';
import type { stepConfigValidator, triggerConfigValidator } from './convexValidators';

// Validator-derived types. The legacy `is*Config` / `is*Trigger` type guards
// were deleted in ADR-0004 phase 7 — per-kind dispatch lives on the step
// module registry (`automations/steps.ts:stepModuleFor`) and trigger module
// registry (`automations/triggers.ts:triggerModuleFor`). Inline `Extract<>`
// narrowing covers the few remaining sites where a `stepType` / `triggerType`
// discriminator is already in scope.

export type StepConfig = Infer<typeof stepConfigValidator>;
export type TriggerConfig = Infer<typeof triggerConfigValidator>;
