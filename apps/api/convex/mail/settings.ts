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
	mailReadingPaneValidator,
	mailListSizeValidator,
	mailInboxModeValidator,
	mailSortOrderValidator,
	mailNotifyAboutValidator,
	mailUndoSendSecondsValidator,
	mailMarkReadPolicyValidator,
	mailQuietHoursValidator,
	mailDailyBriefEmailValidator,
	mailTrashAutoPurgeDaysValidator,
	mailShareLinkExpiryDaysValidator,
} from '../lib/mailSettingsValidators';
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
			readingPane: row.readingPane,
			listWidth: row.listWidth,
			listHeight: row.listHeight,
			inboxMode: row.inboxMode,
			sortOrder: row.sortOrder,
			isSendSoundOn: row.isSendSoundOn,
			undoSendSeconds: row.undoSendSeconds,
			notifyAbout: row.notifyAbout,
			isBadgeNonPeopleOn: row.isBadgeNonPeopleOn,
			quietHours: row.quietHours,
			isHidePreviewOn: row.isHidePreviewOn,
			isSenderScreenerOn: row.isSenderScreenerOn,
			markReadPolicy: row.markReadPolicy,
			dailyBriefEmail: row.dailyBriefEmail,
			lastDailyBriefEmailAt: row.lastDailyBriefEmailAt,
			trashAutoPurgeDays: row.trashAutoPurgeDays,
			shareLinkExpiryDays: row.shareLinkExpiryDays,
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
		readingPane: v.optional(mailReadingPaneValidator),
		listWidth: v.optional(mailListSizeValidator),
		listHeight: v.optional(mailListSizeValidator),
		inboxMode: v.optional(mailInboxModeValidator),
		sortOrder: v.optional(mailSortOrderValidator),
		isSendSoundOn: v.optional(v.boolean()),
		undoSendSeconds: v.optional(mailUndoSendSecondsValidator),
		notifyAbout: v.optional(mailNotifyAboutValidator),
		isBadgeNonPeopleOn: v.optional(v.boolean()),
		quietHours: v.optional(mailQuietHoursValidator),
		isHidePreviewOn: v.optional(v.boolean()),
		isSenderScreenerOn: v.optional(v.boolean()),
		markReadPolicy: v.optional(mailMarkReadPolicyValidator),
		dailyBriefEmail: v.optional(mailDailyBriefEmailValidator),
		trashAutoPurgeDays: v.optional(mailTrashAutoPurgeDaysValidator),
		shareLinkExpiryDays: v.optional(mailShareLinkExpiryDaysValidator),
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
			readingPane?: (typeof args)['readingPane'];
			listWidth?: number;
			listHeight?: number;
			inboxMode?: (typeof args)['inboxMode'];
			sortOrder?: (typeof args)['sortOrder'];
			isSendSoundOn?: boolean;
			undoSendSeconds?: (typeof args)['undoSendSeconds'];
			notifyAbout?: (typeof args)['notifyAbout'];
			isBadgeNonPeopleOn?: boolean;
			quietHours?: (typeof args)['quietHours'];
			isHidePreviewOn?: boolean;
			isSenderScreenerOn?: boolean;
			markReadPolicy?: (typeof args)['markReadPolicy'];
			dailyBriefEmail?: (typeof args)['dailyBriefEmail'];
			trashAutoPurgeDays?: (typeof args)['trashAutoPurgeDays'];
			shareLinkExpiryDays?: (typeof args)['shareLinkExpiryDays'];
		} = {};
		if (args.autoAdvance !== undefined) patch.autoAdvance = args.autoAdvance;
		if (args.isWritingSuggestionsOn !== undefined)
			patch.isWritingSuggestionsOn = args.isWritingSuggestionsOn;
		if (args.isAutoSummarizeOn !== undefined) patch.isAutoSummarizeOn = args.isAutoSummarizeOn;
		if (args.replyDefault !== undefined) patch.replyDefault = args.replyDefault;
		if (args.density !== undefined) patch.density = args.density;
		if (args.viewMode !== undefined) patch.viewMode = args.viewMode;
		if (args.readingPane !== undefined) patch.readingPane = args.readingPane;
		if (args.listWidth !== undefined) patch.listWidth = args.listWidth;
		if (args.listHeight !== undefined) patch.listHeight = args.listHeight;
		if (args.inboxMode !== undefined) patch.inboxMode = args.inboxMode;
		if (args.sortOrder !== undefined) patch.sortOrder = args.sortOrder;
		if (args.isSendSoundOn !== undefined) patch.isSendSoundOn = args.isSendSoundOn;
		if (args.undoSendSeconds !== undefined) patch.undoSendSeconds = args.undoSendSeconds;
		if (args.notifyAbout !== undefined) patch.notifyAbout = args.notifyAbout;
		if (args.isBadgeNonPeopleOn !== undefined) patch.isBadgeNonPeopleOn = args.isBadgeNonPeopleOn;
		if (args.quietHours !== undefined) patch.quietHours = args.quietHours;
		if (args.isHidePreviewOn !== undefined) patch.isHidePreviewOn = args.isHidePreviewOn;
		if (args.isSenderScreenerOn !== undefined) patch.isSenderScreenerOn = args.isSenderScreenerOn;
		if (args.markReadPolicy !== undefined) patch.markReadPolicy = args.markReadPolicy;
		if (args.trashAutoPurgeDays !== undefined) patch.trashAutoPurgeDays = args.trashAutoPurgeDays;
		if (args.shareLinkExpiryDays !== undefined)
			patch.shareLinkExpiryDays = args.shareLinkExpiryDays;
		if (args.dailyBriefEmail !== undefined) {
			// Clamp here rather than trusting the client: `minute` becomes a
			// scheduling comparison in a cron, and an out-of-range value would
			// either never fire or fire every tick.
			patch.dailyBriefEmail = {
				enabled: args.dailyBriefEmail.enabled,
				minute: Math.min(1439, Math.max(0, Math.round(args.dailyBriefEmail.minute))),
				utcOffsetMinutes: Math.min(
					840,
					Math.max(-720, Math.round(args.dailyBriefEmail.utcOffsetMinutes))
				),
			};
		}
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
