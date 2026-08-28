/**
 * Everything this mailbox knows about ONE correspondent, in one read (plan
 * idea 45).
 *
 * The backend already held a lot per sender — how much they write, when they
 * last did, how their mail authenticates — but it was scattered across the row
 * projections of half a dozen views and reachable from nowhere as a whole. The
 * reader's sender line was a text label. This is the query behind making it
 * open something.
 *
 * BOUNDED BY CONSTRUCTION. The `by_mailbox_and_from` index walks newest-first
 * within one sender, and the walk stops at {@link SCAN_LIMIT}. Everything else
 * — the thread list, the counts, the authentication summary — is derived from
 * that one page. A correspondent of ten years is not going to be table-scanned
 * to render a panel, so the numbers say "at least" past the cap rather than
 * pretending to be totals (`isCountCapped`).
 *
 * WHAT IT DOES NOT DO. It never asserts an authentication verdict it did not
 * see: a sample with no recorded DMARC result reports `unknown`, not "fine".
 * And it holds no key material — pinned-key state is a separate, differently
 * authorized read (`e2ee.recipientKeys.getRecipientKeyStatus`) that the panel
 * makes on its own.
 */

import { v } from 'convex/values';
import { publicQuery } from '../lib/authedFunctions';
import { requireMailboxAccess } from './permissions';
import type { QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

/**
 * Messages from this sender the profile reads. Deep enough that the counts and
 * the authentication summary mean something, shallow enough to stay a bounded
 * indexed take on the render path of a slide-over.
 */
const SCAN_LIMIT = 250;

/** Distinct recent conversations listed. The panel is a summary, not a folder. */
const THREAD_LIMIT = 8;

function normalizeEmail(raw: string): string {
	return raw.trim().toLowerCase();
}

/** One recent conversation with this sender, as the panel renders it. */
export interface SenderThreadRow {
	messageId: Id<'mailMessages'>;
	threadId: string;
	subject: string;
	receivedAt: number;
	isUnread: boolean;
	/** The `<folder>` segment of the reader route this message opens in. */
	folderParam: string;
}

/**
 * How this sender's mail authenticates, over the sampled window.
 *
 * `verdict` is deliberately three-valued. `pass` means every sampled message
 * with a recorded DMARC result passed; `mixed` means at least one did not (the
 * interesting case — a sender whose mail sometimes fails is either misconfigured
 * or being spoofed); `unknown` means nothing was recorded to judge, which is
 * what an older MTA or a purely local mailbox looks like.
 */
export interface SenderAuthSummary {
	verdict: 'pass' | 'mixed' | 'unknown';
	/** Sampled messages that carried a DMARC result at all. */
	checked: number;
	/** Of those, how many passed. */
	passed: number;
	/** The most recent verdicts, for the detail line. */
	latest: {
		spf?: string;
		dkim?: string;
		dmarc?: string;
		/** Set when a trusted forwarder's ARC chain rescued a DMARC fail. */
		arcSealer?: string;
	} | null;
}

export interface SenderProfile {
	email: string;
	/** Display name from the newest message that carried one. */
	displayName: string | null;
	messageCount: number;
	/** True when the sender has more mail here than the scan looked at. */
	isCountCapped: boolean;
	firstSeenAt: number | null;
	lastSeenAt: number | null;
	threads: SenderThreadRow[];
	auth: SenderAuthSummary;
}

const EMPTY: Omit<SenderProfile, 'email'> = {
	displayName: null,
	messageCount: 0,
	isCountCapped: false,
	firstSeenAt: null,
	lastSeenAt: null,
	threads: [],
	auth: { verdict: 'unknown', checked: 0, passed: 0, latest: null },
};

/** DMARC verdicts we treat as an actual pass. */
function isDmarcPass(message: Doc<'mailMessages'>): boolean {
	if (message.dmarcResult === 'pass') return true;
	// A DMARC fail that a TRUSTED forwarder's validated ARC chain rescued is a
	// pass for the reader's purposes — the message really is from who it says,
	// it just took a detour. `dmarcOverride` is only ever set on that path.
	return message.dmarcOverride === 'arc';
}

function summarizeAuth(messages: Doc<'mailMessages'>[]): SenderAuthSummary {
	let checked = 0;
	let passed = 0;
	for (const message of messages) {
		if (message.dmarcResult === undefined) continue;
		checked += 1;
		if (isDmarcPass(message)) passed += 1;
	}
	const newest = messages.find((m) => m.dmarcResult !== undefined || m.spfResult !== undefined);
	const latest = newest
		? {
				...(newest.spfResult ? { spf: newest.spfResult } : {}),
				...(newest.dkimResult ? { dkim: newest.dkimResult } : {}),
				...(newest.dmarcResult ? { dmarc: newest.dmarcResult } : {}),
				...(newest.arcSealer ? { arcSealer: newest.arcSealer } : {}),
			}
		: null;
	const verdict = checked === 0 ? 'unknown' : passed === checked ? 'pass' : 'mixed';
	return { verdict, checked, passed, latest };
}

async function collectThreads(
	ctx: QueryCtx,
	messages: Doc<'mailMessages'>[]
): Promise<SenderThreadRow[]> {
	const rows: SenderThreadRow[] = [];
	const seenThreads = new Set<string>();
	// A sender's mail lives in a handful of folders; cache the role lookup rather
	// than reading the same folder row once per message.
	const folderParams = new Map<Id<'mailFolders'>, string>();
	for (const message of messages) {
		if (rows.length >= THREAD_LIMIT) break;
		if (seenThreads.has(message.threadId)) continue;
		seenThreads.add(message.threadId);
		let folderParam = folderParams.get(message.folderId);
		if (folderParam === undefined) {
			const folder = await ctx.db.get(message.folderId);
			folderParam = folder?.role ?? message.folderId;
			folderParams.set(message.folderId, folderParam);
		}
		rows.push({
			messageId: message._id,
			threadId: message.threadId,
			subject: message.subject,
			receivedAt: message.receivedAt,
			isUnread: !message.flagSeen,
			folderParam,
		});
	}
	return rows;
}

/**
 * The sender panel's whole payload for one address.
 *
 * Soft-auth, matching the reader's other per-sender read (`contacts.senderState`):
 * an anonymous or non-owner caller gets the empty profile so the panel renders
 * nothing rather than erroring. Mailbox access is enforced in-handler.
 */
// public: soft-auth — returns an empty profile for anonymous; mailbox access is still enforced in-handler
export const profile = publicQuery({
	args: { mailboxId: v.id('mailboxes'), email: v.string() },
	handler: async (ctx, args): Promise<SenderProfile> => {
		const email = normalizeEmail(args.email);
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok || !email.includes('@')) return { ...EMPTY, email };

		// Newest-first within this one sender; `take` bounds the read.
		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_from', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('fromAddress', email)
			)
			.order('desc')
			.take(SCAN_LIMIT);

		if (messages.length === 0) return { ...EMPTY, email };

		const newest = messages[0]!;
		const oldest = messages[messages.length - 1]!;
		return {
			email,
			displayName: messages.find((m) => m.fromName)?.fromName ?? null,
			messageCount: messages.length,
			isCountCapped: messages.length === SCAN_LIMIT,
			// Only honest while the count is not capped — past it, this is the
			// oldest message SEEN, which the panel labels accordingly.
			firstSeenAt: oldest.receivedAt,
			lastSeenAt: newest.receivedAt,
			threads: await collectThreads(ctx, messages),
			auth: summarizeAuth(messages),
		};
	},
});
