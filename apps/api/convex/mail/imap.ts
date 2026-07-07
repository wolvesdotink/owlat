/**
 * Internal Convex API consumed by the IMAP server (apps/imap).
 *
 * The IMAP server speaks the protocol on port 993 and translates
 * client commands (LIST / SELECT / FETCH / IDLE …) into these
 * internal queries/mutations. Public mutations stay in the per-user
 * mailbox modules (mailMailbox, mailMessageActions, mailLabels) so
 * permission checks live in one place.
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation } from '../_generated/server';
import type { Id, Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { resolveAllowedFromAddressesForCtx } from './identities';
import { rebuildThreadAggregates } from './messageActions';
import { normalizeSubject } from '../lib/emailAddress';

/**
 * Error string used by APPEND to signal a from-address violation. The
 * IMAP server (`apps/imap/src/connection.ts`) string-matches on this
 * prefix to surface the protocol-level [NO-PERM] response instead of a
 * generic "APPEND failed".
 */
export const FROM_NOT_AUTHORIZED_ERROR = 'From address not authorized';

/** LIST output for a single mailbox account. Includes role + counts so the
 *  IMAP server can emit `* LIST (\Inbox \HasNoChildren) "/" "INBOX"` etc. */
export const listFolders = internalQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const folders = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: one mailbox's folders
		return folders.map((f) => ({
			_id: f._id,
			name: f.name,
			role: f.role,
			parentId: f.parentId,
			uidValidity: f.uidValidity,
			uidNext: f.uidNext,
			highestModseq: f.highestModseq,
			totalCount: f.totalCount,
			unseenCount: f.unseenCount,
			subscribed: f.subscribed,
		}));
	},
});

/** SELECT response — returns folder metadata and the message count
 *  required for `* {n} EXISTS / RECENT / OK [UNSEEN]`. */
export const selectFolder = internalQuery({
	args: { folderId: v.id('mailFolders') },
	handler: async (ctx, args) => {
		const folder = await ctx.db.get(args.folderId);
		if (!folder) return null;
		// First-unseen is required for `* OK [UNSEEN]`: the smallest UID with
		// flagSeen=false. The by_folder_and_seen index orders unseen messages by
		// uid, so this is an O(1) `.first()` instead of collecting + JS-sorting the
		// whole folder on every SELECT (a latency-sensitive, frequently-repeated
		// IMAP command).
		const firstUnseen = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_seen', (q) =>
				q.eq('folderId', args.folderId).eq('flagSeen', false),
			)
			.order('asc')
			.first();
		// RFC 3501 §7.1: `* OK [UNSEEN n]` reports the *message sequence
		// number* of the first unseen message, not its UID. The sequence
		// number is the 1-based position by UID ascending, i.e. one more
		// than the count of messages with a smaller UID.
		let firstUnseenSeq: number | undefined;
		if (firstUnseen) {
			const earlier = await ctx.db
				.query('mailMessages')
				.withIndex('by_folder_and_uid', (q) =>
					q.eq('folderId', args.folderId).lt('uid', firstUnseen.uid),
				)
				.collect(); // bounded: one folder's messages in a UID range
			firstUnseenSeq = earlier.length + 1;
		}
		return {
			folder: {
				_id: folder._id,
				name: folder.name,
				role: folder.role,
				uidValidity: folder.uidValidity,
				uidNext: folder.uidNext,
				highestModseq: folder.highestModseq,
				totalCount: folder.totalCount,
				unseenCount: folder.unseenCount,
			},
			firstUnseenUid: firstUnseen?.uid,
			firstUnseenSeq,
		};
	},
});

/** Bulk envelope fetch for IMAP `FETCH 1:* (FLAGS UID INTERNALDATE ENVELOPE)`. */
export const fetchEnvelopes = internalQuery({
	args: {
		folderId: v.id('mailFolders'),
		uidLow: v.number(),
		uidHigh: v.number(),
		modseqSince: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) =>
				q
					.eq('folderId', args.folderId)
					.gte('uid', args.uidLow)
					.lte('uid', args.uidHigh)
			)
			.collect(); // bounded: one folder's messages in a UID range

		const filtered = args.modseqSince
			? messages.filter((m) => m.modseq > (args.modseqSince ?? 0))
			: messages;

		return filtered
			.sort((a, b) => a.uid - b.uid)
			.map((m) => ({
				_id: m._id,
				uid: m.uid,
				modseq: m.modseq,
				rawSize: m.rawSize,
				rfc822MessageId: m.rfc822MessageId,
				inReplyTo: m.inReplyTo,
				references: m.references,
				fromAddress: m.fromAddress,
				fromName: m.fromName,
				toAddresses: m.toAddresses,
				ccAddresses: m.ccAddresses,
				bccAddresses: m.bccAddresses,
				replyToAddress: m.replyToAddress,
				subject: m.subject,
				internalDate: m.internalDate,
				attachments: m.attachments,
				hasAttachments: m.hasAttachments,
				flagSeen: m.flagSeen,
				flagFlagged: m.flagFlagged,
				flagAnswered: m.flagAnswered,
				flagDraft: m.flagDraft,
				flagDeleted: m.flagDeleted,
				customFlags: m.customFlags,
			}));
	},
});

/**
 * All UIDs in a folder, ascending. The IMAP server builds its
 * per-command sequence-number ↔ UID map from this so that non-UID
 * FETCH/STORE sets are interpreted as 1-based positions and the per-row
 * `* {seq} FETCH` reply carries the true sequence number rather than a
 * fabricated 1..N counter (RFC 3501 §2.3.1.2 / §6.4.5 / §6.4.8).
 */
export const listFolderUids = internalQuery({
	args: { folderId: v.id('mailFolders') },
	handler: async (ctx, args) => {
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) => q.eq('folderId', args.folderId))
			.collect(); // bounded: one folder's messages in a UID range
		return messages.map((m) => m.uid).sort((a, b) => a - b);
	},
});

/** For `FETCH RFC822` / `BODY[]` — IMAP server uses the storage id to
 *  stream the raw .eml from Convex storage. */
export const fetchRawStorageId = internalQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const m = await ctx.db.get(args.messageId);
		if (!m) return null;
		return {
			storageId: m.rawStorageId,
			rawSize: m.rawSize,
			internalDate: m.internalDate,
			folderId: m.folderId,
			uid: m.uid,
		};
	},
});

/** Resolve a time-limited download URL for a stored raw RFC822 message.
 *  Consumed by the IMAP server's FETCH (apps/imap) to stream message bodies —
 *  storage URLs can only be minted inside a Convex function (there is no
 *  client-addressable `_storage` module to call from ConvexHttpClient). */
export const getRawStorageUrl = internalQuery({
	args: { storageId: v.id('_storage') },
	handler: async (ctx, args) => ctx.storage.getUrl(args.storageId),
});

/** Mint an upload URL for APPEND so the IMAP server can store a raw message
 *  in file storage before recording it via `appendMessage`. */
export const generateRawUploadUrl = internalMutation({
	args: {},
	handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

/** Resolve the system folder for an account by its IMAP role (\Sent \Trash …) */
export const resolveSpecialFolder = internalQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		role: v.union(
			v.literal('inbox'),
			v.literal('sent'),
			v.literal('drafts'),
			v.literal('trash'),
			v.literal('spam'),
			v.literal('archive')
		),
	},
	handler: async (ctx, args) => {
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('role', args.role)
			)
			.first();
		return folder ? { _id: folder._id, name: folder.name } : null;
	},
});

/** Per-folder highest modseq, used by IDLE to detect changes since last poll. */
export const peekFolderModseq = internalQuery({
	args: { folderId: v.id('mailFolders') },
	handler: async (ctx, args) => {
		const folder = await ctx.db.get(args.folderId);
		if (!folder) return null;
		return {
			highestModseq: folder.highestModseq,
			uidNext: folder.uidNext,
			totalCount: folder.totalCount,
			unseenCount: folder.unseenCount,
		};
	},
});

// ──────────────────────────────────────────────────────────────────
// P5 — IMAP write mutations
//
// Every mutation that touches a folder bumps `highestModseq` so
// CONDSTORE/QRESYNC clients can resync incrementally. UID / modseq
// allocation lives behind these helpers so the IMAP server doesn't
// need to know the storage shape.
// ──────────────────────────────────────────────────────────────────

const IMAP_FLAG_TO_FIELD: Record<string, keyof Doc<'mailMessages'>> = {
	'\\seen': 'flagSeen',
	'\\flagged': 'flagFlagged',
	'\\answered': 'flagAnswered',
	'\\draft': 'flagDraft',
	'\\deleted': 'flagDeleted',
};

async function bumpFolderModseq(
	ctx: MutationCtx,
	folderId: Id<'mailFolders'>
): Promise<number> {
	const folder = await ctx.db.get(folderId);
	if (!folder) throw new Error('Folder not found');
	const next = folder.highestModseq + 1;
	await ctx.db.patch(folderId, { highestModseq: next, updatedAt: Date.now() });
	return next;
}

function isImapSystemFlag(flag: string): boolean {
	return flag.startsWith('\\');
}

interface FlagDelta {
	systemFlags: Partial<Record<'flagSeen' | 'flagFlagged' | 'flagAnswered' | 'flagDraft' | 'flagDeleted', boolean>>;
	customFlagsAdd: string[];
	customFlagsRemove: string[];
}

function buildFlagDelta(
	rawFlags: string[],
	mode: 'set' | 'add' | 'remove'
): FlagDelta {
	const delta: FlagDelta = {
		systemFlags: {},
		customFlagsAdd: [],
		customFlagsRemove: [],
	};
	for (const f of rawFlags) {
		const lower = f.toLowerCase();
		if (isImapSystemFlag(lower)) {
			const field = IMAP_FLAG_TO_FIELD[lower];
			if (!field) continue;
			delta.systemFlags[field as keyof FlagDelta['systemFlags']] = mode !== 'remove';
		} else {
			if (mode === 'remove') delta.customFlagsRemove.push(f);
			else delta.customFlagsAdd.push(f);
		}
	}
	return delta;
}

/**
 * STORE / UID STORE — apply a flag change to one or more messages.
 *
 * `mode` mirrors IMAP semantics: `set` overrides ALL flags with the
 * provided list, `add` (`+FLAGS`) ORs them in, `remove` (`-FLAGS`) clears.
 */
export const storeFlags = internalMutation({
	args: {
		messageIds: v.array(v.id('mailMessages')),
		flags: v.array(v.string()),
		mode: v.union(v.literal('set'), v.literal('add'), v.literal('remove')),
		unchangedSinceModseq: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const updated: Array<{
			messageId: Id<'mailMessages'>;
			uid: number;
			modseq: number;
			flags: string[];
		}> = [];
		const unchanged: Array<{ messageId: Id<'mailMessages'>; uid: number }> = [];

		const folderUnseenDelta = new Map<Id<'mailFolders'>, number>();

		const delta = buildFlagDelta(args.flags, args.mode);

		for (const id of args.messageIds) {
			const message = await ctx.db.get(id);
			if (!message) continue;

			// CONDSTORE: skip messages that have changed since the requested
			// baseline. The IMAP server reports them in the MODIFIED response.
			if (
				args.unchangedSinceModseq !== undefined &&
				message.modseq > args.unchangedSinceModseq
			) {
				unchanged.push({ messageId: message._id, uid: message.uid });
				continue;
			}

			const wasSeen = message.flagSeen;
			const patch: Partial<Doc<'mailMessages'>> = { updatedAt: Date.now() };

			if (args.mode === 'set') {
				patch.flagSeen = !!delta.systemFlags.flagSeen;
				patch.flagFlagged = !!delta.systemFlags.flagFlagged;
				patch.flagAnswered = !!delta.systemFlags.flagAnswered;
				patch.flagDraft = !!delta.systemFlags.flagDraft;
				patch.flagDeleted = !!delta.systemFlags.flagDeleted;
				patch.customFlags = delta.customFlagsAdd;
			} else {
				if (delta.systemFlags.flagSeen !== undefined) patch.flagSeen = delta.systemFlags.flagSeen;
				if (delta.systemFlags.flagFlagged !== undefined) patch.flagFlagged = delta.systemFlags.flagFlagged;
				if (delta.systemFlags.flagAnswered !== undefined) patch.flagAnswered = delta.systemFlags.flagAnswered;
				if (delta.systemFlags.flagDraft !== undefined) patch.flagDraft = delta.systemFlags.flagDraft;
				if (delta.systemFlags.flagDeleted !== undefined) patch.flagDeleted = delta.systemFlags.flagDeleted;
				if (delta.customFlagsAdd.length > 0 || delta.customFlagsRemove.length > 0) {
					const next = new Set(message.customFlags);
					for (const f of delta.customFlagsAdd) next.add(f);
					for (const f of delta.customFlagsRemove) next.delete(f);
					patch.customFlags = Array.from(next);
				}
			}

			// One write path for the folder modseq: bumpFolderModseq reads the
			// folder's persisted highestModseq (which the previous iteration in
			// this batch already patched) and increments it.
			const folderModseqValue = await bumpFolderModseq(ctx, message.folderId);
			patch.modseq = folderModseqValue;

			await ctx.db.patch(id, patch);

			const newSeen = patch.flagSeen ?? message.flagSeen;
			if (newSeen !== wasSeen) {
				const cur = folderUnseenDelta.get(message.folderId) ?? 0;
				folderUnseenDelta.set(message.folderId, cur + (newSeen ? -1 : +1));
			}

			const finalCustom = patch.customFlags ?? message.customFlags;
			const flagsOut: string[] = [];
			if (patch.flagSeen ?? message.flagSeen) flagsOut.push('\\Seen');
			if (patch.flagFlagged ?? message.flagFlagged) flagsOut.push('\\Flagged');
			if (patch.flagAnswered ?? message.flagAnswered) flagsOut.push('\\Answered');
			if (patch.flagDraft ?? message.flagDraft) flagsOut.push('\\Draft');
			if (patch.flagDeleted ?? message.flagDeleted) flagsOut.push('\\Deleted');
			for (const f of finalCustom) flagsOut.push(f);

			updated.push({
				messageId: message._id,
				uid: message.uid,
				modseq: folderModseqValue,
				flags: flagsOut,
			});
		}

		// Apply unseen deltas
		for (const [folderId, deltaCount] of folderUnseenDelta) {
			const folder = await ctx.db.get(folderId);
			if (!folder) continue;
			await ctx.db.patch(folderId, {
				unseenCount: Math.max(0, folder.unseenCount + deltaCount),
				updatedAt: Date.now(),
			});
		}

		return { updated, unchanged };
	},
});

/**
 * COPY — clones a message into another folder of the SAME mailbox.
 * Storage blob is shared (just a new mailMessages row pointing at it).
 * Returns the (sourceUid, targetUid) pairs for `COPYUID` response.
 */
export const copyMessages = internalMutation({
	args: {
		sourceFolderId: v.id('mailFolders'),
		targetFolderId: v.id('mailFolders'),
		messageIds: v.array(v.id('mailMessages')),
	},
	handler: async (ctx, args) => {
		const target = await ctx.db.get(args.targetFolderId);
		const source = await ctx.db.get(args.sourceFolderId);
		if (!target || !source) throw new Error('Folder not found');
		if (target.mailboxId !== source.mailboxId) {
			throw new Error('Cross-mailbox COPY not supported');
		}

		const pairs: Array<{ sourceUid: number; targetUid: number }> = [];
		const now = Date.now();
		let uidNext = target.uidNext;
		let modseq = target.highestModseq + 1;
		let totalDelta = 0;
		let unseenDelta = 0;

		for (const id of args.messageIds) {
			const m = await ctx.db.get(id);
			if (!m || m.folderId !== source._id) continue;

			const newUid = uidNext++;
			const newModseq = modseq++;
			totalDelta += 1;
			if (!m.flagSeen) unseenDelta += 1;

			const { _id, _creationTime, folderId, uid, modseq: _ms, createdAt: _ca, updatedAt: _ua, ...rest } = m;
			void _id; void _creationTime; void folderId; void uid; void _ms; void _ca; void _ua;
			await ctx.db.insert('mailMessages', {
				...rest,
				folderId: target._id,
				uid: newUid,
				modseq: newModseq,
				createdAt: now,
				updatedAt: now,
			});
			pairs.push({ sourceUid: m.uid, targetUid: newUid });
		}

		if (pairs.length > 0) {
			await ctx.db.patch(target._id, {
				uidNext,
				highestModseq: modseq - 1,
				totalCount: target.totalCount + totalDelta,
				unseenCount: target.unseenCount + unseenDelta,
				updatedAt: now,
			});
		}

		return {
			uidValidity: target.uidValidity,
			pairs,
		};
	},
});

/**
 * MOVE (RFC 6851) — atomic relocation. Same UID/modseq allocation as
 * COPY but the source row is removed instead of duplicated.
 */
export const moveMessages = internalMutation({
	args: {
		sourceFolderId: v.id('mailFolders'),
		targetFolderId: v.id('mailFolders'),
		messageIds: v.array(v.id('mailMessages')),
	},
	handler: async (ctx, args) => {
		const target = await ctx.db.get(args.targetFolderId);
		const source = await ctx.db.get(args.sourceFolderId);
		if (!target || !source) throw new Error('Folder not found');
		if (target.mailboxId !== source.mailboxId) {
			throw new Error('Cross-mailbox MOVE not supported');
		}

		const pairs: Array<{ sourceUid: number; targetUid: number }> = [];
		const now = Date.now();
		let uidNext = target.uidNext;
		let modseq = target.highestModseq + 1;
		let totalDelta = 0;
		let unseenDelta = 0;
		let sourceTotalDelta = 0;
		let sourceUnseenDelta = 0;

		for (const id of args.messageIds) {
			const m = await ctx.db.get(id);
			if (!m || m.folderId !== source._id) continue;

			const newUid = uidNext++;
			const newModseq = modseq++;
			totalDelta += 1;
			sourceTotalDelta += 1;
			if (!m.flagSeen) {
				unseenDelta += 1;
				sourceUnseenDelta += 1;
			}

			await ctx.db.patch(id, {
				folderId: target._id,
				uid: newUid,
				modseq: newModseq,
				updatedAt: now,
			});
			pairs.push({ sourceUid: m.uid, targetUid: newUid });
		}

		if (pairs.length > 0) {
			await ctx.db.patch(target._id, {
				uidNext,
				highestModseq: modseq - 1,
				totalCount: target.totalCount + totalDelta,
				unseenCount: target.unseenCount + unseenDelta,
				updatedAt: now,
			});
			await ctx.db.patch(source._id, {
				totalCount: Math.max(0, source.totalCount - sourceTotalDelta),
				unseenCount: Math.max(0, source.unseenCount - sourceUnseenDelta),
				highestModseq: source.highestModseq + 1,
				updatedAt: now,
			});
		}

		return {
			uidValidity: target.uidValidity,
			pairs,
		};
	},
});

/**
 * EXPUNGE — permanently delete all `\Deleted`-flagged messages in a
 * folder. UID EXPUNGE narrows to a UID set.
 *
 * Returns the deleted message-sequence numbers (1-based, ordered by
 * UID asc) so the IMAP server can emit `* {seq} EXPUNGE` per row.
 */
export const expungeFolder = internalMutation({
	args: {
		folderId: v.id('mailFolders'),
		uidSet: v.optional(v.array(v.number())),
	},
	handler: async (ctx, args) => {
		const folder = await ctx.db.get(args.folderId);
		if (!folder) return { sequenceNumbers: [], modseq: 0 };

		const allMessages = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) => q.eq('folderId', args.folderId))
			.collect(); // bounded: one folder's messages in a UID range
		allMessages.sort((a, b) => a.uid - b.uid);

		const uidFilter = args.uidSet ? new Set(args.uidSet) : null;
		const expungedSequences: number[] = [];
		const touchedThreads = new Set<Id<'mailThreads'>>();
		let totalRemoved = 0;
		let unseenRemoved = 0;
		let bytesRemoved = 0;

		// Iterate from the END so sequence numbers stay stable as we delete
		for (let i = allMessages.length - 1; i >= 0; i--) {
			const m = allMessages[i];
			if (!m || !m.flagDeleted) continue;
			if (uidFilter && !uidFilter.has(m.uid)) continue;

			expungedSequences.push(i + 1);
			totalRemoved += 1;
			if (!m.flagSeen) unseenRemoved += 1;
			bytesRemoved += m.rawSize;
			touchedThreads.add(m.threadId);

			try {
				await ctx.storage.delete(m.rawStorageId);
			} catch {
				/* storage may already be gone */
			}
			await ctx.db.delete(m._id);
		}

		// Re-derive thread aggregates (incl. latestMessageId) for any thread that
		// lost a message — otherwise an expunged latest leaves a dangling pointer.
		for (const tid of touchedThreads) {
			await rebuildThreadAggregates(ctx, tid);
		}

		const newModseq = await bumpFolderModseq(ctx, args.folderId);
		if (totalRemoved > 0) {
			await ctx.db.patch(args.folderId, {
				totalCount: Math.max(0, folder.totalCount - totalRemoved),
				unseenCount: Math.max(0, folder.unseenCount - unseenRemoved),
				updatedAt: Date.now(),
			});
			const mailbox = await ctx.db.get(folder.mailboxId);
			if (mailbox) {
				await ctx.db.patch(mailbox._id, {
					usedBytes: Math.max(0, mailbox.usedBytes - bytesRemoved),
					updatedAt: Date.now(),
				});
			}
		}

		// Return ascending so IMAP server can iterate naturally (the array
		// is currently descending because we walked in reverse).
		expungedSequences.reverse();
		return { sequenceNumbers: expungedSequences, modseq: newModseq };
	},
});

/**
 * APPEND — insert an externally-built RFC822 message into a folder.
 * The IMAP server has already written the bytes to ctx.storage; this
 * mutation registers the metadata row.
 */
export const appendMessage = internalMutation({
	args: {
		folderId: v.id('mailFolders'),
		rawStorageId: v.id('_storage'),
		rawSize: v.number(),
		rfc822MessageId: v.string(),
		fromAddress: v.string(),
		fromName: v.optional(v.string()),
		toAddresses: v.array(v.string()),
		ccAddresses: v.array(v.string()),
		bccAddresses: v.array(v.string()),
		subject: v.string(),
		snippet: v.string(),
		htmlBodyInline: v.optional(v.string()),
		textBodyInline: v.optional(v.string()),
		internalDate: v.optional(v.number()),
		flags: v.optional(v.array(v.string())),
	},
	handler: async (ctx, args) => {
		const folder = await ctx.db.get(args.folderId);
		if (!folder) throw new Error('Folder not found');
		const mailbox = await ctx.db.get(folder.mailboxId);
		if (!mailbox || mailbox.status !== 'active') {
			throw new Error('Mailbox not active');
		}

		// Block forged-From APPENDs: the From header parsed from the
		// appended bytes must be an address the mailbox is authorised to
		// send as. Without this an authenticated user could populate their
		// own Sent folder with a fabricated "From: ceo@org.com" entry that
		// later flows into "resend from Sent" UI as a real spoof.
		const allowedFrom = await resolveAllowedFromAddressesForCtx(ctx, folder.mailboxId);
		if (!allowedFrom.includes(args.fromAddress.trim().toLowerCase())) {
			throw new Error(FROM_NOT_AUTHORIZED_ERROR);
		}

		const now = Date.now();
		const internalDate = args.internalDate ?? now;
		const uid = folder.uidNext;
		const modseq = folder.highestModseq + 1;

		const flagSet = new Set((args.flags ?? []).map((f) => f.toLowerCase()));
		const customFlags: string[] = [];
		for (const f of args.flags ?? []) {
			if (!isImapSystemFlag(f.toLowerCase())) customFlags.push(f);
		}

		// Create or reuse a thread for the appended message. APPEND is most
		// commonly used for client-side draft saves, so default to a fresh
		// thread when there's no inReplyTo.
		const normalizedSubject = normalizeSubject(args.subject);
		const threadId = await ctx.db.insert('mailThreads', {
			mailboxId: folder.mailboxId,
			normalizedSubject,
			participants: [args.fromAddress, ...args.toAddresses],
			messageCount: 1,
			unreadCount: flagSet.has('\\seen') ? 0 : 1,
			hasFlagged: flagSet.has('\\flagged'),
			hasAttachments: false,
			lastMessageAt: internalDate,
			firstMessageAt: internalDate,
			latestSnippet: args.snippet,
			latestFromAddress: args.fromAddress,
			latestSubject: args.subject,
			folderRoles: folder.role ? [folder.role] : [],
			labelIds: [],
			createdAt: now,
			updatedAt: now,
		});

		const messageId = await ctx.db.insert('mailMessages', {
			mailboxId: folder.mailboxId,
			folderId: folder._id,
			uid,
			modseq,
			rfc822MessageId: args.rfc822MessageId,
			threadId,
			fromAddress: args.fromAddress,
			fromName: args.fromName,
			toAddresses: args.toAddresses,
			ccAddresses: args.ccAddresses,
			bccAddresses: args.bccAddresses,
			subject: args.subject,
			normalizedSubject,
			snippet: args.snippet,
			rawStorageId: args.rawStorageId,
			rawSize: args.rawSize,
			textBodyInline: args.textBodyInline,
			htmlBodyInline: args.htmlBodyInline,
			attachments: [],
			hasAttachments: false,
			flagSeen: flagSet.has('\\seen'),
			flagFlagged: flagSet.has('\\flagged'),
			flagAnswered: flagSet.has('\\answered'),
			flagDraft: flagSet.has('\\draft') || folder.role === 'drafts',
			flagDeleted: flagSet.has('\\deleted'),
			customFlags,
			labelIds: [],
			receivedAt: internalDate,
			internalDate,
			createdAt: now,
			updatedAt: now,
		});

		// The conversation list links to latestMessageId; set it now that the
		// appended message exists.
		await ctx.db.patch(threadId, { latestMessageId: messageId });

		await ctx.db.patch(folder._id, {
			uidNext: uid + 1,
			highestModseq: modseq,
			totalCount: folder.totalCount + 1,
			unseenCount: folder.unseenCount + (flagSet.has('\\seen') ? 0 : 1),
			updatedAt: now,
		});
		await ctx.db.patch(mailbox._id, {
			usedBytes: mailbox.usedBytes + args.rawSize,
			updatedAt: now,
		});

		return {
			messageId,
			uid,
			uidValidity: folder.uidValidity,
			modseq,
		};
	},
});

/**
 * Helper: resolve the IMAP-visible message ids for a UID set. Used by
 * the IMAP server to translate `STORE 1:* +FLAGS \Seen` into the
 * concrete mailMessages ids that `storeFlags` expects.
 */
export const resolveMessageIdsByUid = internalQuery({
	args: {
		folderId: v.id('mailFolders'),
		uidLow: v.number(),
		uidHigh: v.number(),
	},
	handler: async (ctx, args) => {
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_folder_and_uid', (q) =>
				q
					.eq('folderId', args.folderId)
					.gte('uid', args.uidLow)
					.lte('uid', args.uidHigh)
			)
			.collect(); // bounded: one folder's messages in a UID range
		return messages
			.sort((a, b) => a.uid - b.uid)
			.map((m) => ({
				_id: m._id,
				uid: m.uid,
				modseq: m.modseq,
			}));
	},
});
