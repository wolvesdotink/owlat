/**
 * Bidirectional commitment / deadline tracking (Daily Brief).
 *
 * A commitment is either
 *   - `inbound`  — a deadline SOMEONE GAVE the owner ("please send it by Fri"), or
 *   - `outbound` — a promise the OWNER MADE in their own sent mail ("I'll get
 *     the draft to you Friday").
 *
 * Outbound promises are the invisible half today: the user's own "I will send
 * it Friday" leaves no trace, so the promise silently lapses. This module makes
 * both directions first-class.
 *
 * Pipeline (all fail-soft; never blocks ingest, never sends mail):
 *   1. A deterministic gate (`looksLikeOutboundCommitment` /
 *      `shouldExtractOutboundCommitment`, pure + unit-tested) bounds the LLM
 *      fan-out — bulk/automated senders and mass recipients are skipped before
 *      any spend.
 *   2. The cheap-tier LLM refinement (mail/commitmentExtract.ts, 'use node')
 *      extracts the structured commitment behind the same aiGate as the rest of
 *      Postbox AI. Any gate/model failure just leaves no commitment row.
 *   3. The reminder sweep (`sweep` below) surfaces an OPEN commitment before its
 *      deadline — arming the thread follow-up (mail/followUps.ts) so it floats
 *      into the Reply Queue as a "You're waiting…" item — and flips it to
 *      `reminded` exactly once, so a promise can't lapse unseen.
 *
 * Advisory only: this never sends or modifies mail.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { getOrThrow, throwForbidden } from '../_utils/errors';
import { isBulkOrNoReplySender } from './needsReply';
import { armThreadFollowUp, followUpWaitingOn } from './followUps';
import { requireMailboxAccess, loadReadableMailbox } from './permissions';

// ─── Pure helpers ────────────────────────────────────────────────────────────

export type CommitmentDirection = 'inbound' | 'outbound';

/** Cap on the persisted commitment description. */
const MAX_DESCRIPTION_CHARS = 200;

/**
 * First-person promise phrasing — the cheap deterministic gate that decides
 * whether a sent message is even worth an LLM extraction pass. Matches "I'll",
 * "I will", "we'll", "I'm going to", "let me get/send", "I can send/get/have",
 * "I'll get back". Deliberately loose (recall over precision): the LLM makes the
 * final call, this only avoids spend on mail that clearly makes no promise. Pure.
 */
const OUTBOUND_PROMISE_RE =
	/\b(i['’]?ll|i\s+will|we['’]?ll|we\s+will|i['’]?m\s+going\s+to|let\s+me\s+(get|send|check|follow)|i\s+can\s+(send|get|have|do)|i['’]?ll\s+get\s+back|i\s+promise|by\s+(end\s+of|eod|cob|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+week|tomorrow))\b/i;

export function looksLikeOutboundCommitment(text: string): boolean {
	return OUTBOUND_PROMISE_RE.test(text);
}

/**
 * Bound the outbound-commitment LLM fan-out: extract only from a sent message
 * that is a genuine 1:1/small-group reply, never from bulk/automated output or
 * a mass send. Skips when the sender is a bulk/no-reply address or the message
 * went to more than `MAX_RECIPIENTS` people. Pure so the gate unit-tests
 * without Convex.
 */
const MAX_RECIPIENTS = 5;

export function shouldExtractOutboundCommitment(opts: {
	fromAddress: string;
	toAddresses: string[];
	ccAddresses?: string[];
	hasListUnsubscribe: boolean;
	bodyText: string;
}): boolean {
	if (opts.toAddresses.length === 0) return false;
	const recipientCount = opts.toAddresses.length + (opts.ccAddresses?.length ?? 0);
	if (recipientCount > MAX_RECIPIENTS) return false;
	if (
		isBulkOrNoReplySender({
			fromAddress: opts.fromAddress,
			hasListUnsubscribe: opts.hasListUnsubscribe,
		})
	) {
		return false;
	}
	return looksLikeOutboundCommitment(opts.bodyText);
}

/**
 * Parse an ISO date hint (YYYY-MM-DD) to an absolute deadline timestamp,
 * anchored to the END of that day in UTC so a same-day promise isn't treated as
 * already lapsed. Returns `undefined` for a non-parseable hint. Pure. (Mirrors
 * needsReplyClassify.normalizeDueHint's ISO guard, extended to a timestamp.)
 */
export function dueHintToTimestamp(dueHint: string | null | undefined): number | undefined {
	if (!dueHint) return undefined;
	const trimmed = dueHint.trim();
	if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return undefined;
	const ms = Date.parse(`${trimmed.slice(0, 10)}T23:59:59.999Z`);
	return Number.isNaN(ms) ? undefined : ms;
}

/** Clamp a description to the persisted cap; returns undefined when empty. */
export function clampDescription(raw: string | null | undefined): string | undefined {
	const t = (raw ?? '').trim();
	if (t.length === 0) return undefined;
	return t.slice(0, MAX_DESCRIPTION_CHARS);
}

/** How many recent sent messages the sweep inspects per mailbox. */
const SENT_SCAN_LIMIT = 40;
/** Max outbound extractions scheduled per mailbox per sweep tick. */
const EXTRACT_PER_MAILBOX = 5;

// ─── Extraction context (for the 'use node' action) ─────────────────────────

/** Bounded source-message context for the commitment extraction action. */
export const getMessageContext = internalQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const message = await ctx.db.get(args.messageId);
		if (!message) return null;
		const mailbox = await ctx.db.get(message.mailboxId);
		if (!mailbox || mailbox.status !== 'active') return null;
		const body = (message.textBodyInline ?? message.snippet ?? '').slice(0, 8000);
		return {
			mailboxId: message.mailboxId,
			threadId: message.threadId,
			ownerAddress: mailbox.address.toLowerCase(),
			fromAddress: message.fromAddress,
			toAddress: message.toAddresses[0],
			subject: message.subject,
			body,
		};
	},
});

// ─── Persist an extracted commitment (idempotent) ────────────────────────────

export const applyCommitment = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		threadId: v.id('mailThreads'),
		messageId: v.id('mailMessages'),
		direction: v.union(v.literal('inbound'), v.literal('outbound')),
		description: v.string(),
		counterparty: v.optional(v.string()),
		dueAt: v.optional(v.number()),
		dueHintRaw: v.optional(v.string()),
		source: v.union(v.literal('heuristic'), v.literal('llm')),
	},
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('mailCommitments')
			.withIndex('by_message', (q) =>
				q.eq('messageId', args.messageId).eq('direction', args.direction)
			)
			.first();
		const now = Date.now();
		// A resolved (done/lapsed/reminded) commitment is never revived by a later
		// re-extraction — only an OPEN row is refreshed.
		if (existing) {
			if (existing.status === 'open') {
				await ctx.db.patch(existing._id, {
					description: args.description,
					counterparty: args.counterparty,
					dueAt: args.dueAt,
					dueHintRaw: args.dueHintRaw,
					source: args.source,
					updatedAt: now,
				});
			}
			return;
		}
		await ctx.db.insert('mailCommitments', {
			mailboxId: args.mailboxId,
			threadId: args.threadId,
			messageId: args.messageId,
			direction: args.direction,
			description: args.description,
			counterparty: args.counterparty,
			dueAt: args.dueAt,
			dueHintRaw: args.dueHintRaw,
			status: 'open',
			source: args.source,
			createdAt: now,
			updatedAt: now,
		});
	},
});

// ─── Reminder sweep (cron) ───────────────────────────────────────────────────

/** Active mailboxes scanned per sweep tick. */
const MAILBOX_SCAN_LIMIT = 50;
/** Surface an open commitment this long before its deadline (pre-lapse). */
export const REMIND_WINDOW_MS = 60 * 60 * 1000; // 1 hour
/** Open commitments inspected per mailbox per tick. */
const COMMITMENT_SCAN_LIMIT = 50;
/** Global cap on extractions scheduled per sweep tick. */
const GLOBAL_EXTRACT_CAP = 40;

/**
 * Commitment sweep cron. Two bounded passes over active mailboxes:
 *   1. Schedule LLM extraction for recent sent promises with no commitment row.
 *   2. Arm a pre-lapse reminder for any OPEN commitment whose deadline is within
 *      REMIND_WINDOW_MS — reusing mail/followUps.ts so the thread floats into
 *      the Reply Queue — and flip it to `reminded` exactly once.
 *
 * One bounded transaction: it reads ≤ MAILBOX_SCAN_LIMIT mailboxes and, per
 * mailbox, ≤ SENT_SCAN_LIMIT sent messages (Pass 1) + ≤ COMMITMENT_SCAN_LIMIT
 * open commitments (Pass 2) — worst case ~50 × (40 + 50) ≈ 4,500 reads, well
 * under Convex's per-transaction read cap. The LLM extraction itself is NEVER
 * run here: Pass 1 only fans it out via `ctx.scheduler`, and each extraction
 * runs (and fails soft) in its own scheduled action. The reminder writes in
 * Pass 2 patch `thread.followUp` + the commitment row; the GLOBAL_EXTRACT_CAP
 * is a cross-mailbox guard, so the passes stay in this single transaction rather
 * than a per-mailbox fan-out — a throw in one mailbox's pass therefore aborts
 * the whole tick, but the next 30-min tick simply retries and the sweep is
 * idempotent (extraction is de-duped by the `by_message` guard; the reminder
 * only flips `open → reminded` once).
 */
export const sweep = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const mailboxes = await ctx.db
			.query('mailboxes')
			.withIndex('by_status', (q) => q.eq('status', 'active'))
			.take(MAILBOX_SCAN_LIMIT);

		let scheduled = 0;
		let reminded = 0;
		for (const mailbox of mailboxes) {
			// ── Pass 1: schedule outbound-commitment extraction (bounded) ──
			// Scan recent sent mail directly (mutation ctx), schedule the LLM action.
			const recent = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', mailbox._id))
				.order('desc')
				.take(SENT_SCAN_LIMIT);
			let perMailbox = 0;
			for (const msg of recent) {
				if (scheduled >= GLOBAL_EXTRACT_CAP || perMailbox >= EXTRACT_PER_MAILBOX) break;
				if (msg.outbound === undefined) continue;
				const body = msg.textBodyInline ?? msg.snippet ?? '';
				if (
					!shouldExtractOutboundCommitment({
						fromAddress: msg.fromAddress,
						toAddresses: msg.toAddresses,
						ccAddresses: msg.ccAddresses,
						hasListUnsubscribe: msg.unsubscribe !== undefined,
						bodyText: body,
					})
				) {
					continue;
				}
				const already = await ctx.db
					.query('mailCommitments')
					.withIndex('by_message', (q) => q.eq('messageId', msg._id).eq('direction', 'outbound'))
					.first();
				if (already) continue;
				await ctx.scheduler.runAfter(0, internal.mail.commitmentExtract.extractCommitment, {
					messageId: msg._id,
					direction: 'outbound',
				});
				scheduled += 1;
				perMailbox += 1;
			}

			// ── Pass 2: pre-lapse reminders for open commitments ──
			const open = await ctx.db
				.query('mailCommitments')
				.withIndex('by_mailbox_status_due', (q) =>
					q
						.eq('mailboxId', mailbox._id)
						.eq('status', 'open')
						.lte('dueAt', now + REMIND_WINDOW_MS)
				)
				.take(COMMITMENT_SCAN_LIMIT);
			for (const commitment of open) {
				if (commitment.dueAt === undefined) continue; // no concrete deadline
				const message = await ctx.db.get(commitment.messageId);
				if (!message) {
					await ctx.db.patch(commitment._id, { status: 'lapsed', updatedAt: Date.now() });
					continue;
				}
				// Reuse the follow-up watch so the thread surfaces in the Reply Queue
				// as a "You're waiting…" item (needsReply.listQueue reads followUp.dueAt).
				await armThreadFollowUp(ctx, {
					threadId: commitment.threadId,
					messageId: commitment.messageId,
					remindAt: now,
					waitingOn: commitment.counterparty ?? followUpWaitingOn(message.toAddresses),
				});
				await ctx.db.patch(commitment._id, {
					status: 'reminded',
					remindedAt: now,
					updatedAt: now,
				});
				reminded += 1;
			}
		}
		return { scheduled, reminded };
	},
});

// ─── Read + resolve (in-app surface) ─────────────────────────────────────────

/** Cap on the in-app commitments list. */
const LIST_LIMIT = 100;

interface CommitmentView {
	id: Id<'mailCommitments'>;
	threadId: Id<'mailThreads'>;
	direction: CommitmentDirection;
	description: string;
	counterparty?: string;
	dueAt?: number;
	dueHintRaw?: string;
	status: Doc<'mailCommitments'>['status'];
}

function toView(row: Doc<'mailCommitments'>): CommitmentView {
	return {
		id: row._id,
		threadId: row.threadId,
		direction: row.direction,
		description: row.description,
		counterparty: row.counterparty,
		dueAt: row.dueAt,
		dueHintRaw: row.dueHintRaw,
		status: row.status,
	};
}

/**
 * In-app commitments list for a mailbox (Daily Brief drill-in). Bounded; soft
 * auth (empty for anonymous / non-owner / inactive mailbox).
 */
export const listCommitments = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<{ items: CommitmentView[] }> => {
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return { items: [] };
		const rows = await listMailboxCommitments(ctx, args.mailboxId);
		const items: CommitmentView[] = [];
		for (const row of rows) items.push(toView(row));
		return { items };
	},
});

async function listMailboxCommitments(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>
): Promise<Doc<'mailCommitments'>[]> {
	return await ctx.db
		.query('mailCommitments')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
		.order('desc')
		.take(LIST_LIMIT);
}

/** Mark a commitment done (the owner fulfilled or dismissed it). */
// authz: commitment → mailbox access via requireMailboxAccess; org membership via
// authedMutation.
export const resolveCommitment = authedMutation({
	args: { commitmentId: v.id('mailCommitments') },
	handler: async (ctx, args) => {
		const commitment = await getOrThrow(ctx, args.commitmentId, 'Commitment');
		const owned = await requireMailboxAccess(ctx, commitment.mailboxId);
		if (!owned.ok) throwForbidden('Commitment not accessible');
		await ctx.db.patch(args.commitmentId, { status: 'done', updatedAt: Date.now() });
	},
});
