/**
 * Vacation auto-responder (RFC 3834-compliant).
 *
 * One responder per mailbox at most. The actual delivery-time logic
 * lives in deliveryHooks.runPostDelivery; this module exposes the CRUD
 * surface plus the internal load / dedup-log helpers it consumes.
 *
 * Anti-loop guards (all applied in deliveryHooks.runPostDelivery):
 *   - skip if message is automated: Auto-Submitted (RFC 3834 §3),
 *     List-Id (mailing list), or auto Precedence — via isAutomatedMail
 *   - skip if sender == self
 *   - skip if the SMTP return-path is null/empty (bounce/DSN; RFC 3834 §2,
 *     RFC 5321 §4.5.5) or there is no sender address to reply to
 *   - skip if the responder window is currently outside [startAt, endAt]
 *   - skip if we've already replied to this sender within `replyIntervalDays`
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { loadOwnedMailbox } from './permissions';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';

const DEFAULT_REPLY_INTERVAL_DAYS = 7;

// public: soft-auth — returns empty for anonymous; mailbox ownership is still enforced in-handler
export const get = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) return null;
		return ctx.db
			.query('mailVacationResponders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.first();
	},
});

export const upsert = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		isEnabled: v.boolean(),
		subject: v.string(),
		bodyText: v.string(),
		bodyHtml: v.optional(v.string()),
		startAt: v.optional(v.number()),
		endAt: v.optional(v.number()),
		replyIntervalDays: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');

		const trimmedSubject = args.subject.trim();
		if (!trimmedSubject) throwInvalidInput('Subject required');
		const trimmedBody = args.bodyText.trim();
		if (!trimmedBody) throwInvalidInput('Body required');
		if (args.startAt && args.endAt && args.endAt < args.startAt) {
			throwInvalidInput('endAt must be after startAt');
		}

		const existing = await ctx.db
			.query('mailVacationResponders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.first();

		const now = Date.now();
		const data = {
			mailboxId: args.mailboxId,
			isEnabled: args.isEnabled,
			subject: trimmedSubject,
			bodyText: trimmedBody,
			bodyHtml: args.bodyHtml,
			startAt: args.startAt,
			endAt: args.endAt,
			replyIntervalDays:
				args.replyIntervalDays !== undefined && args.replyIntervalDays > 0
					? args.replyIntervalDays
					: DEFAULT_REPLY_INTERVAL_DAYS,
			updatedAt: now,
		};

		if (existing) {
			await ctx.db.patch(existing._id, data);
			return existing._id;
		}
		return ctx.db.insert('mailVacationResponders', { ...data, createdAt: now });
	},
});

export const remove = authedMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Not accessible');
		const existing = await ctx.db
			.query('mailVacationResponders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.first();
		if (existing) await ctx.db.delete(existing._id);
	},
});

// ── Internal helpers used by mailDelivery.deliverToMailbox ────────

export const internalLoad = internalQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		return ctx.db
			.query('mailVacationResponders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.first();
	},
});

export const internalLastReplied = internalQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		senderEmail: v.string(),
	},
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query('mailVacationLog')
			.withIndex('by_mailbox_and_sender', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('senderEmail', args.senderEmail)
			)
			.first();
		return row?.repliedAt ?? null;
	},
});

export const internalRecordReply = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		senderEmail: v.string(),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('mailVacationLog')
			.withIndex('by_mailbox_and_sender', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('senderEmail', args.senderEmail)
			)
			.first();
		const now = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, { repliedAt: now });
		} else {
			await ctx.db.insert('mailVacationLog', {
				mailboxId: args.mailboxId,
				senderEmail: args.senderEmail,
				repliedAt: now,
			});
		}
	},
});
