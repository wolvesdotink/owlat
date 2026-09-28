/**
 * Feature-gated function builders for the automations module.
 *
 * They compose the org-member auth floor (`authedQuery` / `authedMutation`)
 * with the `automations` feature floor, so every public handler in
 * `automations/**` refuses to run while the flag is off instead of each one
 * remembering `assertFeatureEnabled(ctx, 'automations')`
 * (`scripts/check-feature-floors.sh` fails on a new inline copy). The
 * `automations:manage` role gate and the draft/lifecycle guards
 * (`automations/guards.ts`) still live in the handler; the floor here decides
 * only whether the surface exists on this instance. The web gates
 * `/dashboard/automations` on the same flag.
 *
 * `internal*` functions are untouched: the step walker, the trigger fan-out and
 * the stalled-run sweeper run with no user session, and runs already in flight
 * when the flag goes off are theirs to finish or park.
 *
 * Not exported as Convex functions (the leading underscore keeps this module
 * off the public API surface); only imported by sibling `automations/**`
 * modules.
 */

import { authedQuery, authedMutation, featureGated } from '../lib/authedFunctions';

export const automationsQuery = featureGated(authedQuery, 'automations');
export const automationsMutation = featureGated(authedMutation, 'automations');
