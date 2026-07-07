/**
 * ADR-0005 phase 3 — Backfill the `'webhook'` channel literal to `'generic'`
 * across `unifiedMessages` and `channelConfigs`.
 *
 * Idempotent: re-running is a no-op once every row has been rewritten.
 * Pre-prod, so this runs synchronously against `.collect()`. If this ever
 * ships against production-sized tables, paginate via `withIndex('by_channel')`
 * scoped to the legacy literal.
 */

import { internalMutation } from '../_generated/server';

export const run = internalMutation({
	args: {},
	handler: async (ctx) => {
		let unifiedMessagesUpdated = 0;
		let channelConfigsUpdated = 0;

		for (const msg of await ctx.db.query('unifiedMessages').collect()) { // bounded: one-shot pre-prod migration (see header)
			if ((msg.channel as string) === 'webhook') {
				await ctx.db.patch(msg._id, { channel: 'generic' });
				unifiedMessagesUpdated++;
			}
		}

		for (const cfg of await ctx.db.query('channelConfigs').collect()) { // bounded: one-shot pre-prod migration (see header)
			if ((cfg.channel as string) === 'webhook') {
				await ctx.db.patch(cfg._id, { channel: 'generic' });
				channelConfigsUpdated++;
			}
		}

		return { unifiedMessagesUpdated, channelConfigsUpdated };
	},
});
