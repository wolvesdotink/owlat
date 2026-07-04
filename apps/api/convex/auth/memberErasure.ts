/**
 * Member-scoped GDPR erasure — the batched background job behind account
 * deletion for NON-owner members.
 *
 * Before this module, deleting a member's account removed their BetterAuth
 * membership and userProfile but left everything they owned: their personal
 * mailbox with all mail (and its storage blobs), app passwords, external
 * IMAP/SMTP account credentials, chat authorship, and mentions.
 *
 * Owners take the organization-deletion walker instead (the whole tenant
 * dataset goes); this job erases exactly one user's personal data and runs as
 * a self-scheduled batched walk so a mailbox with 100k messages can't blow a
 * single mutation's limits.
 *
 * Phases per hop:
 *   1. While the user has a mailbox: drain one batch of its mailMessages
 *      (purging the up-to-three storage blobs per row); once drained, delete
 *      the mailbox's children (folders/labels/filters/signatures/drafts incl.
 *      attachment blobs/threads/aliases/imap-sync/app-passwords) and the
 *      mailbox row itself.
 *   2. External accounts (encrypted IMAP/SMTP credentials!) + folder-sync
 *      state + any user-keyed app passwords.
 *   3. Chat: anonymize authored messages ('[deleted account]') page by page —
 *      room conversations keep their flow, the identity goes; drop room
 *      memberships and mentions.
 *   4. Mark the deletion request completed.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

const MESSAGE_BATCH = 100;
const CHAT_PAGE = 200;

export const eraseMemberData = internalMutation({
	args: {
		authUserId: v.string(),
		requestId: v.id('accountDeletionRequests'),
		chatCursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const reschedule = async (chatCursor?: string) => {
			await ctx.scheduler.runAfter(0, internal.auth.memberErasure.eraseMemberData, {
				authUserId: args.authUserId,
				requestId: args.requestId,
				...(chatCursor !== undefined ? { chatCursor } : {}),
			});
		};

		// ── Phase 1: personal mailboxes ──
		const mailbox = await ctx.db
			.query('mailboxes')
			.withIndex('by_user', (q) => q.eq('userId', args.authUserId))
			.first();
		if (mailbox) {
			const messages = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailbox._id))
				.take(MESSAGE_BATCH);
			for (const msg of messages) {
				await ctx.storage.delete(msg.rawStorageId);
				if (msg.textBodyStorageId) await ctx.storage.delete(msg.textBodyStorageId);
				if (msg.htmlBodyStorageId) await ctx.storage.delete(msg.htmlBodyStorageId);
				await ctx.db.delete(msg._id);
			}
			if (messages.length === MESSAGE_BATCH) {
				await reschedule();
				return;
			}

			// Messages drained — remove the mailbox's bounded children + itself.
			for (const row of await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
				.collect()) {
				await ctx.db.delete(row._id); // bounded: per-mailbox configuration rows
			}
			for (const row of await ctx.db
				.query('mailLabels')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
				.collect()) {
				await ctx.db.delete(row._id); // bounded: per-mailbox configuration rows
			}
			for (const row of await ctx.db
				.query('mailVoiceProfiles')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
				.collect()) {
				await ctx.db.delete(row._id); // bounded: per-mailbox configuration rows
			}
			for (const row of await ctx.db
				.query('mailContactStyleOverrides')
				.withIndex('by_mailbox_and_address', (q) => q.eq('mailboxId', mailbox._id))
				.collect()) {
				await ctx.db.delete(row._id); // bounded: per-mailbox learned-style rows
			}
			for (const row of await ctx.db
				.query('mailFilters')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
				.collect()) {
				await ctx.db.delete(row._id); // bounded: per-mailbox configuration rows
			}
			for (const row of await ctx.db
				.query('mailSignatures')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
				.collect()) {
				await ctx.db.delete(row._id); // bounded: per-mailbox configuration rows
			}
			for (const row of await ctx.db
				.query('mailSnippets')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
				.collect()) {
				await ctx.db.delete(row._id); // bounded: per-mailbox configuration rows
			}
			for (const row of await ctx.db
				.query('mailAppPasswords')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
				.collect()) {
				await ctx.db.delete(row._id); // bounded: per-mailbox configuration rows
			}
			const commitmentRows = await ctx.db
				.query('mailCommitments')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
				.collect(); // bounded: per-mailbox commitment rows
			for (const row of commitmentRows) await ctx.db.delete(row._id);
			const briefRows = await ctx.db
				.query('mailDailyBriefs')
				.withIndex('by_mailbox_and_generated', (q) => q.eq('mailboxId', mailbox._id))
				.collect(); // bounded: per-mailbox brief snapshots
			for (const row of briefRows) await ctx.db.delete(row._id);
			for (const row of await ctx.db
				.query('mailAliases')
				.withIndex('by_target', (q) => q.eq('targetMailboxId', mailbox._id))
				.collect()) {
				await ctx.db.delete(row._id); // bounded: per-mailbox configuration rows
			}
			const drafts = await ctx.db
				.query('mailDrafts')
				.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
				.collect(); // bounded: per-mailbox drafts
			for (const draft of drafts) {
				for (const att of draft.attachments) {
					await ctx.storage.delete(att.storageId);
				}
				await ctx.db.delete(draft._id);
			}

			const threads = await ctx.db
				.query('mailThreads')
				.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', mailbox._id))
				.collect(); // bounded: threads of one (already message-drained) mailbox
			for (const thread of threads) await ctx.db.delete(thread._id);

			await ctx.db.delete(mailbox._id);
			await reschedule();
			return;
		}

		// ── Phase 2: external account credentials + user-keyed leftovers ──
		const externalAccounts = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_user', (q) => q.eq('userId', args.authUserId))
			.collect(); // bounded: a user connects a handful of accounts
		for (const account of externalAccounts) {
			const syncRows = await ctx.db
				.query('externalMailFolderSync')
				.withIndex('by_account', (q) => q.eq('accountId', account._id))
				.collect(); // bounded: folders of one account
			for (const row of syncRows) await ctx.db.delete(row._id);
			await ctx.db.delete(account._id);
		}
		const userPasswords = await ctx.db
			.query('mailAppPasswords')
			.withIndex('by_user', (q) => q.eq('userId', args.authUserId))
			.collect(); // bounded: a user's own app passwords
		for (const pw of userPasswords) await ctx.db.delete(pw._id);

		// ── Phase 3: chat — anonymize authorship page by page ──
		const page = await ctx.db
			.query('chatMessages')
			.paginate({ cursor: args.chatCursor ?? null, numItems: CHAT_PAGE });
		for (const msg of page.page) {
			if (msg.authorId === args.authUserId) {
				await ctx.db.patch(msg._id, { authorId: '[deleted account]' });
			}
		}
		if (!page.isDone) {
			await reschedule(page.continueCursor);
			return;
		}

		const memberships = await ctx.db
			.query('chatRoomMembers')
			.withIndex('by_member', (q) => q.eq('memberId', args.authUserId))
			.collect(); // bounded: rooms one user belongs to
		for (const membership of memberships) await ctx.db.delete(membership._id);

		const mentions = await ctx.db
			.query('chatMentions')
			.withIndex('by_mentioned_unread', (q) => q.eq('mentionedMemberId', args.authUserId))
			.collect(); // bounded: one user's mentions
		for (const mention of mentions) await ctx.db.delete(mention._id);

		// ── Phase 4: done ──
		const request = await ctx.db.get(args.requestId as Id<'accountDeletionRequests'>);
		if (request && request.status !== 'completed') {
			await ctx.db.patch(args.requestId, {
				status: 'completed',
				statusChangedAt: Date.now(),
			});
		}
	},
});
