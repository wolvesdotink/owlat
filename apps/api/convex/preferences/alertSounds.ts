/**
 * The opt-in alert sounds: one switch per alert a person can ask to hear (a
 * reply on a thread armed with "notify me when they reply", a conversation
 * assigned to them, an agent question waiting on their answer).
 *
 * Stored on the person's `mailUserSettings` row and read back through the
 * soft-auth `mail.settings.get`, which carries no feature floor. Written HERE
 * rather than through `mail.settings.update`: the assignment and question
 * sounds belong to the Team inbox, so an instance with only `inbox` on must be
 * able to save them, while the mail reading preferences keep their
 * personal-mail floor. Each switch keeps the floor of the alert it sounds for:
 * the reply sound needs personal mail, the other two need the Team inbox. This
 * door writes the three sound fields and nothing else.
 */

import { v } from 'convex/values';
import { authedMutation } from '../lib/authedFunctions';
import { assertAnyFeatureEnabled, assertFeatureEnabled } from '../lib/featureFlags';

export const update = authedMutation({
	args: {
		isReplyAlertSoundOn: v.optional(v.boolean()),
		isAssignmentSoundOn: v.optional(v.boolean()),
		isQuestionSoundOn: v.optional(v.boolean()),
	},
	// authz: self-scoped — upserts only the caller's own settings row (keyed by
	// the session userId; no cross-user id is accepted).
	handler: async (ctx, args, session) => {
		// The floor: some alert this door covers exists on the instance.
		await assertAnyFeatureEnabled(ctx, ['postbox', 'mail.external', 'inbox']);
		if (args.isReplyAlertSoundOn !== undefined) {
			// Armed replies are personal mail (mail/threadAlerts.ts).
			await assertAnyFeatureEnabled(ctx, ['postbox', 'mail.external']);
		}
		if (args.isAssignmentSoundOn !== undefined || args.isQuestionSoundOn !== undefined) {
			// Assignment and agent-question notices come from the Team inbox.
			await assertFeatureEnabled(ctx, 'inbox');
		}

		const patch: {
			isReplyAlertSoundOn?: boolean;
			isAssignmentSoundOn?: boolean;
			isQuestionSoundOn?: boolean;
		} = {};
		if (args.isReplyAlertSoundOn !== undefined)
			patch.isReplyAlertSoundOn = args.isReplyAlertSoundOn;
		if (args.isAssignmentSoundOn !== undefined)
			patch.isAssignmentSoundOn = args.isAssignmentSoundOn;
		if (args.isQuestionSoundOn !== undefined) patch.isQuestionSoundOn = args.isQuestionSoundOn;

		const existing = await ctx.db
			.query('mailUserSettings')
			.withIndex('by_user', (q) => q.eq('userId', session.userId))
			.first();
		const now = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
			return existing._id;
		}
		return ctx.db.insert('mailUserSettings', {
			// The row's one required preference; the same default the mail
			// settings write when a person first saves anything else.
			autoAdvance: 'next',
			...patch,
			userId: session.userId,
			createdAt: now,
			updatedAt: now,
		});
	},
});
