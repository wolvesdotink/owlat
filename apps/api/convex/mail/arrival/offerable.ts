/**
 * Read on arrival (final review F1): which messages may offer their body text
 * to a short model read (the digest lines, R2's rule questions, the gist),
 * through `scopedInput.ts buildScopedMessageInput`.
 *
 * Exactly the messages interpretation itself would read: an enqueue snapshot
 * that is eligible (live, a real folder, not muted, not a stranger's bulk mail
 * once the category is settled, `interpret/eligibility.ts`), and no terminal
 * exclusion at arrival (depth `none`: security mail, a suppressed sender, AI
 * off). Anything else is shown by its subject only.
 */

import { v } from 'convex/values';
import { internalQuery } from '../../_generated/server';
import { isInterpretationEligible, settleCategory } from '../interpret/eligibility';
import { loadInterpretSource } from '../interpret/sources';

export const isOfferable = internalQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args): Promise<boolean> => {
		const message = await ctx.db.get(args.messageId);
		if (!message || message.outbound !== undefined) return false;
		const row = await loadInterpretSource(ctx, { kind: 'mail', id: args.messageId });
		if (!row) return false;
		if (row.readOutcome !== undefined && row.isUpgradeable === false) return false;
		const thread = await ctx.db.get(message.threadId);
		const settled = settleCategory(row.eligibility, {
			...(thread?.category ? { threadCategory: thread.category } : {}),
			capturedAt: row.createdAt,
			now: Date.now(),
			direction: 'inbound',
		});
		// A stranger's bulk mail whose category is still settling is not read
		// yet by interpretation either: nothing is offered (final review r2 F1).
		if (!('signals' in settled)) return false;
		return isInterpretationEligible(settled.signals, { direction: 'inbound' }).isEligible;
	},
});
