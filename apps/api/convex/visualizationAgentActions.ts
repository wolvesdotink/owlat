'use node';

/**
 * Previous-release path of `analytics/visualizationAgentActions.ts`. A
 * generation the previous release scheduled (`createFromPrompt` and
 * `regenerate` queue it with no delay) runs `visualizationAgentActions:generate`
 * by path, with the arguments that release recorded. It keeps its old path,
 * builder, arguments and result shape, and runs the same body as its
 * replacement. Remove after release 0.6.17.
 */

import { v } from 'convex/values';
import { anchorActionDeadline } from './lib/llm/actionDeadline';
import { internalAction } from './_generated/server';
import { datasetKeyValidator } from './analytics/visualizationAgent';
import { generateVisualization } from './analytics/visualizationAgentActions';

/** Remove after release 0.6.17; this release schedules `analytics/visualizationAgentActions:generate`. */
export const generate = internalAction({
	args: {
		visualizationId: v.id('visualizations'),
		prompt: v.string(),
		dataset: v.optional(datasetKeyValidator),
	},
	handler: async (ctx, args) => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		return await generateVisualization(ctx, args);
	},
});
