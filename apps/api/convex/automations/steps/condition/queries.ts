import { v } from 'convex/values';
import { internalQuery } from '../../../_generated/server';
import { evaluateAgainstContact, parseCondition } from '../../../conditions';

/**
 * Internal query: evaluate a single condition against one contact.
 *
 * The condition step's action calls this — `evaluateAgainstContact` needs
 * a `DatabaseReader`, which actions don't have directly.
 */
export const evaluateConditionForContact = internalQuery({
	args: {
		contactId: v.id('contacts'),
		conditionJson: v.string(), // serialized canonical Condition
	},
	handler: async (ctx, args) => {
		const contact = await ctx.db.get(args.contactId);
		if (!contact) return { ok: false as const, reason: 'contact-not-found' };

		const condition = parseCondition(JSON.parse(args.conditionJson));
		const result = await evaluateAgainstContact(ctx, [condition], 'AND', contact);
		return { ok: true as const, result };
	},
});
