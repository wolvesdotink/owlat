/**
 * Previous-release paths of `analytics/visualizationAgent.ts`. The
 * visualizations page and the pinned visualizations card in a tab opened
 * before the deploy still read and edit through `visualizationAgent:*` by
 * path, and a previous release's generation still running when this one
 * deploys reads its dataset and commits its page through the internal
 * functions by their old paths. Each function keeps its old path, builder,
 * auth floor, arguments and result shape, and runs the same body as its
 * replacement. Remove after release 0.6.17.
 */

import { v } from 'convex/values';
import { internalQuery } from './_generated/server';
import { internalMutation } from './lib/writeFence';
import { adminQuery, adminMutation } from './lib/authedFunctions';
import {
	createFromPromptArgs,
	createVisualization,
	listPinnedVisualizations,
	listVisualizations,
	readAgentHealthSnapshot,
	readCampaignPerformance,
	readContactGrowth,
	readEmailDelivery30d,
	regenerateVisualization,
	removeVisualization,
	toggleVisualizationPin,
	updateGeneratedArgs,
	writeGeneratedPage,
} from './analytics/visualizationAgent';

/** Remove after release 0.6.17; this release calls `analytics/visualizationAgent:list`. */
export const list = adminQuery({
	args: { limit: v.optional(v.number()) },
	handler: async (ctx, args) => await listVisualizations(ctx, args),
});

/** Remove after release 0.6.17; this release calls `analytics/visualizationAgent:listPinned`. */
export const listPinned = adminQuery({
	args: {},
	handler: async (ctx) => await listPinnedVisualizations(ctx),
});

/** Remove after release 0.6.17; this release calls `analytics/visualizationAgent:createFromPrompt`. */
export const createFromPrompt = adminMutation({
	args: createFromPromptArgs,
	handler: async (ctx, args, session) => await createVisualization(ctx, args, session.userId),
});

/** Remove after release 0.6.17; this release calls `analytics/visualizationAgent:regenerate`. */
export const regenerate = adminMutation({
	args: { id: v.id('visualizations') },
	handler: async (ctx, args) => await regenerateVisualization(ctx, args),
});

/** Remove after release 0.6.17; this release calls `analytics/visualizationAgent:togglePin`. */
export const togglePin = adminMutation({
	args: { id: v.id('visualizations') },
	handler: async (ctx, args) => await toggleVisualizationPin(ctx, args),
});

/** Remove after release 0.6.17; this release calls `analytics/visualizationAgent:remove`. */
export const remove = adminMutation({
	args: { id: v.id('visualizations') },
	handler: async (ctx, args) => await removeVisualization(ctx, args),
});

/** Remove after release 0.6.17; this release calls `analytics/visualizationAgent:updateGenerated`. */
export const updateGenerated = internalMutation({
	args: updateGeneratedArgs,
	handler: async (ctx, args) => await writeGeneratedPage(ctx, args),
});

/** Remove after release 0.6.17; this release calls `analytics/visualizationAgent:dataEmailDelivery30d`. */
export const dataEmailDelivery30d = internalQuery({
	args: {},
	handler: async (ctx) => await readEmailDelivery30d(ctx),
});

/** Remove after release 0.6.17; this release calls `analytics/visualizationAgent:dataAgentHealth`. */
export const dataAgentHealth = internalQuery({
	args: {},
	handler: async (ctx) => await readAgentHealthSnapshot(ctx),
});

/** Remove after release 0.6.17; this release calls `analytics/visualizationAgent:dataContactGrowth`. */
export const dataContactGrowth = internalQuery({
	args: {},
	handler: async (ctx) => await readContactGrowth(ctx),
});

/** Remove after release 0.6.17; this release calls `analytics/visualizationAgent:dataCampaignPerformance`. */
export const dataCampaignPerformance = internalQuery({
	args: {},
	handler: async (ctx) => await readCampaignPerformance(ctx),
});
