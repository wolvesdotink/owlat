/**
 * Per-user Postbox behavior preferences.
 *
 * One `mailUserSettings` row per BetterAuth user at most, spanning all of
 * the user's mailboxes (these are reader-behavior preferences of the
 * person, not properties of a mailbox). Currently a single preference:
 *
 *   - `autoAdvance` — what the thread reader does after the open message
 *     is triaged away (archive / trash / snooze / spam): open the next
 *     conversation in list order (default), the previous one, or go back
 *     to the list.
 *
 * Mirrors the vacation/forwarding modules' get/update shape; rows are
 * keyed by the session user rather than a mailbox id.
 */

import { v } from 'convex/values';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import {
	mailAutoAdvanceValidator,
	mailReplyDefaultValidator,
	mailDensityValidator,
	mailViewModeValidator,
	mailNotifyAboutValidator,
} from '../lib/convexValidators';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';

// public: soft-auth — returns null for anonymous; the row is self-scoped to
// the session user, so nothing leaks.
export const get = publicQuery({
	args: {},
	handler: async (ctx) => {
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s || !s.role) return null;
		const row = await ctx.db
			.query('mailUserSettings')
			.withIndex('by_user', (q) => q.eq('userId', s.userId))
			.first();
		if (!row) return null;
		return {
			autoAdvance: row.autoAdvance,
			isWritingSuggestionsOn: row.isWritingSuggestionsOn,
			isAutoSummarizeOn: row.isAutoSummarizeOn,
			replyDefault: row.replyDefault,
			density: row.density,
			viewMode: row.viewMode,
			isSendSoundOn: row.isSendSoundOn,
			notifyAbout: row.notifyAbout,
			isBadgeNonPeopleOn: row.isBadgeNonPeopleOn,
			isSenderScreenerOn: row.isSenderScreenerOn,
		};
	},
});

export const update = authedMutation({
	// All fields optional so callers can patch a single preference (e.g. only the
	// writing-suggestions toggle) without clobbering the others.
	args: {
		autoAdvance: v.optional(mailAutoAdvanceValidator),
		isWritingSuggestionsOn: v.optional(v.boolean()),
		isAutoSummarizeOn: v.optional(v.boolean()),
		replyDefault: v.optional(mailReplyDefaultValidator),
		density: v.optional(mailDensityValidator),
		viewMode: v.optional(mailViewModeValidator),
		isSendSoundOn: v.optional(v.boolean()),
		notifyAbout: v.optional(mailNotifyAboutValidator),
		isBadgeNonPeopleOn: v.optional(v.boolean()),
		isSenderScreenerOn: v.optional(v.boolean()),
	},
	// authz: self-scoped — upserts only the caller's own settings row (keyed
	// by the session userId; no cross-user id is accepted).
	handler: async (ctx, args) => {
		const s = await getBetterAuthSessionWithRole(ctx);
		if (!s) return null; // unreachable past the authedMutation floor
		const existing = await ctx.db
			.query('mailUserSettings')
			.withIndex('by_user', (q) => q.eq('userId', s.userId))
			.first();
		const now = Date.now();
		const patch: {
			autoAdvance?: (typeof args)['autoAdvance'];
			isWritingSuggestionsOn?: boolean;
			isAutoSummarizeOn?: boolean;
			replyDefault?: (typeof args)['replyDefault'];
			density?: (typeof args)['density'];
			viewMode?: (typeof args)['viewMode'];
			isSendSoundOn?: boolean;
			notifyAbout?: (typeof args)['notifyAbout'];
			isBadgeNonPeopleOn?: boolean;
			isSenderScreenerOn?: boolean;
		} = {};
		if (args.autoAdvance !== undefined) patch.autoAdvance = args.autoAdvance;
		if (args.isWritingSuggestionsOn !== undefined)
			patch.isWritingSuggestionsOn = args.isWritingSuggestionsOn;
		if (args.isAutoSummarizeOn !== undefined) patch.isAutoSummarizeOn = args.isAutoSummarizeOn;
		if (args.replyDefault !== undefined) patch.replyDefault = args.replyDefault;
		if (args.density !== undefined) patch.density = args.density;
		if (args.viewMode !== undefined) patch.viewMode = args.viewMode;
		if (args.isSendSoundOn !== undefined) patch.isSendSoundOn = args.isSendSoundOn;
		if (args.notifyAbout !== undefined) patch.notifyAbout = args.notifyAbout;
		if (args.isBadgeNonPeopleOn !== undefined) patch.isBadgeNonPeopleOn = args.isBadgeNonPeopleOn;
		if (args.isSenderScreenerOn !== undefined) patch.isSenderScreenerOn = args.isSenderScreenerOn;
		if (existing) {
			await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
			return existing._id;
		}
		return ctx.db.insert('mailUserSettings', {
			// A fresh row needs a concrete autoAdvance; default it when the caller
			// only set another preference.
			autoAdvance: args.autoAdvance ?? 'next',
			...patch,
			userId: s.userId,
			createdAt: now,
			updatedAt: now,
		});
	},
});
