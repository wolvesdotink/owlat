'use node';

/**
 * Previous-release path of `assistant/quickQuery.ts`. The command palette's
 * Ask mode in a tab opened before the deploy still calls `quickQuery:ask` by
 * path. It keeps its old path, builder, auth floor, arguments and result
 * shape, and runs the same body as its replacement. Remove after release
 * 0.6.17.
 */

import { v } from 'convex/values';
import { anchorActionDeadline } from './lib/llm/actionDeadline';
import { authedAction } from './lib/authedFunctions';
import { answerQuestion, type QuickQueryAnswer } from './assistant/quickQuery';

/** Remove after release 0.6.17; this release calls `assistant/quickQuery:ask`. */
// authz: gate enforced in quickQueryGate.assertKnowledgeReadAccess via
// ctx.runQuery inside answerQuestion (ai.knowledge feature flag +
// knowledge:read permission), as on the moved function.
export const ask = authedAction({
	args: {
		question: v.string(),
	},
	handler: async (ctx, args): Promise<QuickQueryAnswer> => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		return await answerQuestion(ctx, args);
	},
});
