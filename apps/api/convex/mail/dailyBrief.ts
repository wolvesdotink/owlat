/**
 * Daily Brief — the "what needs you today" digest.
 *
 * There is no single place that answers "what needs me today". Categories only
 * split the inbox (off by default); the Reply Queue is one slice; deadlines and
 * the owner's own promises are invisible. This cron assembles all of it, once a
 * day per active mailbox, into a persisted `mailDailyBriefs` snapshot:
 *
 *   - a RANKED "needs you" list (mail/priorityScore.ts ordering) of pending
 *     replies + clarification questions + due follow-ups + open commitments /
 *     deadlines, and
 *   - an AUDITABLE bundle of low-signal mail (newsletters / receipts /
 *     notifications — mail/category.ts) it folded away. A digest that silently
 *     hides something important is a trust-killer, so the exact bundled threads
 *     are always inspectable.
 *
 * Read-only in-app surface (getLatestBrief). Never sends or modifies mail; an
 * email delivery of the brief is a separate opt-in. Deterministic — the ranking
 * reads scores already persisted by the Reply Queue classifier, so the cron
 * itself makes no LLM call and can't fail-open into hiding a real task.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { publicQuery } from '../lib/authedFunctions';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { urgencyFallbackScore } from './priorityScore';
import { loadReadableMailbox } from './permissions';

// ─── Pure ranking + bundling (unit-tested, framework-free) ───────────────────

export type BriefItemKind = 'needs_reply' | 'clarification' | 'followup' | 'commitment';

export interface BriefItem {
	kind: BriefItemKind;
	threadId: Id<'mailThreads'>;
	priorityScore: number;
	title: string;
	subtitle?: string;
	dueAt?: number;
}

/** A lapsing promise/deadline is urgent — rank commitments at the high baseline. */
export const COMMITMENT_PRIORITY = urgencyFallbackScore('high');

/**
 * Rank the "needs you" items: highest priority first, then the SOONER deadline
 * first (an item with a concrete dueAt outranks one without at equal score),
 * then most-recent kind grouping is irrelevant. Pure + stable — unit-tested for
 * the "high-priority reply outranks a low-priority newsletter reply" and
 * "sooner deadline breaks a score tie" contracts.
 */
export function rankBriefItems(items: BriefItem[]): BriefItem[] {
	return [...items].sort((a, b) => {
		if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
		const ad = a.dueAt ?? Number.POSITIVE_INFINITY;
		const bd = b.dueAt ?? Number.POSITIVE_INFINITY;
		return ad - bd;
	});
}

export type BundledCategory = 'newsletter' | 'notification' | 'receipt';

export interface BundledEntry {
	threadId: Id<'mailThreads'>;
	category: BundledCategory;
	fromAddress: string;
	subject: string;
}

/** The low-signal categories the brief bundles away (person/other never bundled). */
const BUNDLED_CATEGORIES: readonly BundledCategory[] = ['newsletter', 'notification', 'receipt'];

export function isBundledCategory(label: string): label is BundledCategory {
	for (const c of BUNDLED_CATEGORIES) if (c === label) return true;
	return false;
}

/**
 * Fold a set of low-signal threads into the auditable digest bundle + per-
 * category counts. Pure — the counts always equal the listed entries, which is
 * the auditability contract (nothing is counted that isn't shown, nothing shown
 * that isn't counted).
 */
export function bundleLowSignal(entries: BundledEntry[]): {
	bundled: BundledEntry[];
	bundledCounts: { newsletter: number; notification: number; receipt: number };
} {
	const bundledCounts = { newsletter: 0, notification: 0, receipt: 0 };
	for (const e of entries) bundledCounts[e.category] += 1;
	return { bundled: entries, bundledCounts };
}

// ─── Cron: build the brief per active mailbox ────────────────────────────────

/** Active mailboxes processed per cron tick. */
const MAILBOX_SCAN_LIMIT = 50;
/** Recent inbox threads scanned per mailbox for pending items + bundling. */
const THREAD_SCAN_LIMIT = 300;
/** Cap on ranked items / bundled entries persisted per brief. */
const MAX_ITEMS = 100;
const MAX_BUNDLED = 200;

/**
 * Rebuild the Daily Brief for every active mailbox. This dispatcher only reads
 * the active-mailbox list and fans out one `buildForMailbox` mutation per
 * mailbox via the scheduler — each brief is then built in its OWN transaction,
 * which (a) bounds every transaction to a single mailbox's ~≤700 reads, well
 * under Convex's per-transaction read cap, and (b) makes the fail-soft promise
 * real: a throw while building one mailbox's brief fails only that scheduled
 * mutation, never the dispatcher or the other mailboxes. Reads already-persisted
 * signals only — no LLM spend, no mail mutations.
 */
export const buildDailyBriefs = internalMutation({
	args: {},
	handler: async (ctx) => {
		const mailboxes = await ctx.db
			.query('mailboxes')
			.withIndex('by_status', (q) => q.eq('status', 'active'))
			.take(MAILBOX_SCAN_LIMIT);

		let scheduled = 0;
		for (const mailbox of mailboxes) {
			await ctx.scheduler.runAfter(0, internal.mail.dailyBrief.buildForMailbox, {
				mailboxId: mailbox._id,
			});
			scheduled += 1;
		}
		return { scheduled };
	},
});

/**
 * Build (and persist) the Daily Brief for a single mailbox. Scheduled once per
 * active mailbox by `buildDailyBriefs`, so this whole handler is one bounded
 * transaction: ≤ THREAD_SCAN_LIMIT thread reads (+ one message read per pending
 * reply) + ≤ MAX_ITEMS commitment reads + one insert.
 */
export const buildForMailbox = internalMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		await buildBriefForMailbox(ctx, args.mailboxId);
	},
});

async function buildBriefForMailbox(ctx: MutationCtx, mailboxId: Id<'mailboxes'>): Promise<void> {
	const now = Date.now();

	const threads = await ctx.db
		.query('mailThreads')
		.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', mailboxId))
		.order('desc')
		.take(THREAD_SCAN_LIMIT);

	const items: BriefItem[] = [];
	const bundledEntries: BundledEntry[] = [];

	for (const thread of threads) {
		// Pending reply / clarification.
		const nr = thread.needsReply;
		if (nr) {
			const message = await ctx.db.get(nr.messageId);
			if (message && !isMessageSnoozed(message, now)) {
				const isClarify = nr.clarification?.isNeeded === true;
				items.push({
					kind: isClarify ? 'clarification' : 'needs_reply',
					threadId: thread._id,
					priorityScore: nr.priorityScore ?? urgencyFallbackScore(nr.urgency),
					title: thread.latestSubject || '(no subject)',
					subtitle: isClarify ? 'Needs your input' : (nr.askSummary ?? message.fromAddress),
					dueAt: undefined,
				});
			}
		}

		// Due follow-up (sent mail whose reminder passed).
		if (thread.followUp?.dueAt !== undefined) {
			items.push({
				kind: 'followup',
				threadId: thread._id,
				priorityScore: urgencyFallbackScore('normal'),
				title: thread.latestSubject || '(no subject)',
				subtitle: thread.followUp.waitingOn
					? `Waiting on ${thread.followUp.waitingOn}`
					: 'Awaiting reply',
				dueAt: thread.followUp.dueAt,
			});
		}

		// Low-signal bundle (only inbox threads; person/other are never bundled).
		const cat = thread.category?.label;
		if (
			bundledEntries.length < MAX_BUNDLED &&
			thread.folderRoles.includes('inbox') &&
			cat !== undefined &&
			isBundledCategory(cat)
		) {
			bundledEntries.push({
				threadId: thread._id,
				category: cat,
				fromAddress: thread.latestFromAddress,
				subject: thread.latestSubject || '(no subject)',
			});
		}
	}

	// Open / reminded commitments with a concrete deadline — the invisible half.
	const commitments = await ctx.db
		.query('mailCommitments')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
		.order('desc')
		.take(MAX_ITEMS);
	for (const c of commitments) {
		if (c.status === 'done' || c.status === 'lapsed') continue;
		items.push({
			kind: 'commitment',
			threadId: c.threadId,
			priorityScore: COMMITMENT_PRIORITY,
			title: c.description,
			subtitle:
				c.direction === 'outbound'
					? `You promised${c.counterparty ? ` ${c.counterparty}` : ''}`
					: `Due to${c.counterparty ? ` ${c.counterparty}` : ''}`,
			dueAt: c.dueAt,
		});
	}

	const ranked = rankBriefItems(items).slice(0, MAX_ITEMS);
	const { bundled, bundledCounts } = bundleLowSignal(bundledEntries);

	await ctx.db.insert('mailDailyBriefs', {
		mailboxId,
		generatedAt: now,
		items: ranked,
		bundled,
		bundledCounts,
		createdAt: now,
	});
}

// ─── Read side (in-app surface) ──────────────────────────────────────────────

/**
 * The latest Daily Brief for a mailbox — the ranked "needs you" list plus the
 * auditable low-signal bundle. Soft auth (null for anonymous / non-owner /
 * inactive mailbox).
 */
export const getLatestBrief = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<Doc<'mailDailyBriefs'> | null> => {
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return null;
		return await ctx.db
			.query('mailDailyBriefs')
			.withIndex('by_mailbox_and_generated', (q) => q.eq('mailboxId', args.mailboxId))
			.order('desc')
			.first();
	},
});
