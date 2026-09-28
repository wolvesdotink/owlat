/**
 * Feature-gated function builders for the embeddable-forms module.
 *
 * They compose the org-member auth floor (`authedQuery` / `authedMutation`)
 * with the `forms` feature floor, so the member-facing form management
 * handlers in `forms/**` no longer repeat `assertFeatureEnabled(ctx, 'forms')`
 * by hand (`scripts/check-feature-floors.sh` fails on a new inline copy). The
 * `forms:*` permission checks still live in the handler; the floor here
 * decides only whether the surface exists on this instance.
 *
 * NOT for every function under `forms/`:
 *   - the recipient-facing `publicQuery` / `publicMutation` pair behind the
 *     double-opt-in link (`getByConfirmationToken`, `confirmSubmission`) stays
 *     public and ungated: a subscriber who submitted while the flag was on must
 *     still be able to confirm.
 *   - `internal*` functions are untouched.
 *
 * Not exported as Convex functions (the leading underscore keeps this module
 * off the public API surface); only imported by sibling `forms/**` modules.
 */

import { authedQuery, authedMutation, featureGated } from '../lib/authedFunctions';

export const formsQuery = featureGated(authedQuery, 'forms');
export const formsMutation = featureGated(authedMutation, 'forms');
