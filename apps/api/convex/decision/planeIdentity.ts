'use node';

/**
 * The identity of the decision plane as it resolves NOW, for the block-only
 * auto-send gate (ADR-0060 §8): the resolver's own output
 * (`lib/decisionProvider.ts resolveDecisionConfig`), never a second reading
 * of its precedence, so a stored kind with an env model or origin, an env
 * fallback after the stored config is removed, or a degraded provider each
 * have the identity of the endpoint a call would actually use.
 */

import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { resolveDecisionConfig } from '../lib/decisionProvider';
import { resolvedPlaneIdentity } from '../lib/decision/configIdentity';
import { anchorActionDeadline } from '../lib/llm/actionDeadline';

export const resolvedIdentity = internalAction({
	args: { isDecisionPlaneOn: v.boolean() },
	handler: async (ctx, args): Promise<string> => {
		anchorActionDeadline(ctx);
		if (!args.isDecisionPlaneOn) return resolvedPlaneIdentity(null, false);
		const plane = await resolveDecisionConfig(ctx).catch(() => null);
		return resolvedPlaneIdentity(plane, true);
	},
});
