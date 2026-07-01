/**
 * Access gate for the Quick Query ask-anything action.
 *
 * `quickQuery.ask` is a `'use node'` action (it makes an LLM synthesis call), so
 * it cannot touch `ctx.db` and cannot run the query-time gate helpers directly.
 * This companion internal query runs BOTH gates the mutation used to run inline —
 * exactly as before, in the same order — and the action calls it via
 * `ctx.runQuery` before any retrieval happens.
 */

import { internalQuery } from './_generated/server';
import { assertFeatureEnabled } from './lib/featureFlags';
import { requireOrgPermission } from './lib/sessionOrganization';

/**
 * Assert the caller may read the knowledge graph via Quick Query:
 *   1. the `ai.knowledge` feature flag (asserted FIRST so a disabled feature
 *      fails the same way regardless of who is asking), then
 *   2. org membership with `knowledge:read` (granted to every member role).
 * Throws (forbidden) when either gate fails; the action aborts before retrieval.
 */
export const assertKnowledgeReadAccess = internalQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'ai.knowledge');
		await requireOrgPermission(ctx, 'knowledge:read');
	},
});
