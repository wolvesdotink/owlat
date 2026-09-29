/**
 * Feature-gated function builders for the transactional module.
 *
 * They compose the org-member auth floor (`authedQuery` / `authedMutation`)
 * with the `transactional` feature floor, so a handler in `transactional/**`
 * no longer repeats `assertFeatureEnabled(ctx, 'transactional')` by hand
 * (`scripts/check-feature-floors.sh` fails on a new inline copy). The
 * `transactional:*` permission checks and the draft/publish guards still live
 * in the handler; the floor here decides only whether the surface exists on
 * this instance. The web gates `/dashboard/send/transactional` on the same flag.
 *
 * `internal*` functions are untouched: the dispatch pipeline runs with no user
 * session and must finish draining sends that are already queued.
 *
 * Not exported as Convex functions (the leading underscore keeps this module
 * off the public API surface); only imported by sibling `transactional/**`
 * modules.
 */

import { authedQuery, authedMutation, featureGated } from '../lib/authedFunctions';

export const transactionalQuery = featureGated(authedQuery, 'transactional');
export const transactionalMutation = featureGated(authedMutation, 'transactional');
