/**
 * The observer's capture-side storage seam (plan §7.2, §7.3).
 *
 * Everything here runs in the V8 isolate and touches only `ctx.db`. The
 * machinery that DECIDES anything — admissibility, dedupe, the k-floor,
 * signing — lives in `@owlat/ostr-observer`, which reaches `node:crypto` and
 * therefore only ever runs inside the Node actions in `observer.ts` /
 * `window.ts`. This module is what those actions read and write through, and it
 * deliberately holds no policy: a rule stated in two runtimes is a rule that
 * will eventually disagree with itself.
 *
 * The one exception is `enqueueReport`, which re-checks the dedupe key inside
 * its own transaction. That is not a second opinion but the atomic half of the
 * package's `ReportDedupeStore` contract: the action's `has` read and its `add`
 * write are separated by a network hop, and two users junking the same replayed
 * message in that gap would otherwise both capture it.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { OstrDkimEvidence } from './signals';
import {
	OSTR_MAILBOX_PAGE_SIZE,
	OSTR_MAX_MAILBOX_PAGES,
	OSTR_MAX_QUEUED_REPORTS,
	OSTR_MAX_WINDOW_EVIDENCE,
	OSTR_MAX_WINDOW_MESSAGES_PER_MAILBOX,
} from './config';

/**
 * Persist one message's DKIM evidence, inline in the delivery transaction.
 *
 * A plain helper rather than a mutation: the row belongs to the message, and a
 * scheduled write could land after a user has already junked it — which is the
 * one moment the evidence has to exist. Idempotent by message, because a
 * delivery retry must not mint a second bundle for the same bytes.
 *
 * The caller has already checked observer mode. This function stores what it is
 * given and judges nothing; whether these bytes are EVIDENCE is
 * `@owlat/ostr-core`'s admissibility call, made on the report path.
 */
export async function recordOstrEvidence(
	ctx: MutationCtx,
	params: {
		messageId: Id<'mailMessages'>;
		mailboxId: Id<'mailboxes'>;
		evidence: OstrDkimEvidence;
	}
): Promise<void> {
	const existing = await ctx.db
		.query('ostrEvidence')
		.withIndex('by_message', (q) => q.eq('messageId', params.messageId))
		.first();
	if (existing !== null) return;
	await ctx.db.insert('ostrEvidence', {
		messageId: params.messageId,
		mailboxId: params.mailboxId,
		evidence: params.evidence,
		createdAt: Date.now(),
	});
}

/** The evidence captured for one message, or `null` when the message predates
 *  observer mode (or arrived unsigned). No row ⇒ no admissible report. */
export const getEvidence = internalQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (
		ctx,
		args
	): Promise<{ mailboxId: Id<'mailboxes'>; evidence: OstrDkimEvidence } | null> => {
		const row = await ctx.db
			.query('ostrEvidence')
			.withIndex('by_message', (q) => q.eq('messageId', args.messageId))
			.first();
		return row === null ? null : { mailboxId: row.mailboxId, evidence: row.evidence };
	},
});

/** Whether a dedupe key has already been captured — the read half of the
 *  package's `ReportDedupeStore.has`. Rows survive their emission, so this
 *  answers for the whole retention window, not just the pending queue. */
export const isReportCaptured = internalQuery({
	args: { dedupeKey: v.string() },
	handler: async (ctx, args): Promise<boolean> => {
		const row = await ctx.db
			.query('ostrReportQueue')
			.withIndex('by_dedupe_key', (q) => q.eq('dedupeKey', args.dedupeKey))
			.first();
		return row !== null;
	},
});

/**
 * The write half of the dedupe store, with the race closed.
 *
 * Returns `false` when the key was already present — the caller's earlier
 * `has` read is advisory, and a concurrent report of the same replayed message
 * must lose here rather than double-commit the same bundle into a batch.
 */
export const enqueueReport = internalMutation({
	args: {
		subjectDomain: v.string(),
		messageId: v.id('mailMessages'),
		bundleHash: v.string(),
		reporterToken: v.string(),
		dedupeKey: v.string(),
		capturedAt: v.string(),
	},
	handler: async (ctx, args): Promise<boolean> => {
		const existing = await ctx.db
			.query('ostrReportQueue')
			.withIndex('by_dedupe_key', (q) => q.eq('dedupeKey', args.dedupeKey))
			.first();
		if (existing !== null) return false;
		await ctx.db.insert('ostrReportQueue', { ...args, createdAt: Date.now() });
		return true;
	},
});

export interface QueuedReport {
	id: Id<'ostrReportQueue'>;
	subjectDomain: string;
	bundleHash: string;
	reporterToken: string;
}

/**
 * Every report still waiting for a publishable window, oldest first — report
 * order, which is also commitment order (§7.2.4: an opening names an index in
 * exactly this list).
 *
 * The `emittedAt: undefined` range is the held queue by construction, so this
 * shrinks to nothing on an instance whose windows clear the k-floor.
 */
export const listPendingReports = internalQuery({
	args: {},
	handler: async (ctx): Promise<QueuedReport[]> => {
		const rows = await ctx.db
			.query('ostrReportQueue')
			.withIndex('by_emitted_and_subject', (q) => q.eq('emittedAt', undefined))
			.take(OSTR_MAX_QUEUED_REPORTS);
		return rows.map((row) => ({
			id: row._id,
			subjectDomain: row.subjectDomain,
			bundleHash: row.bundleHash,
			reporterToken: row.reporterToken,
		}));
	},
});

/**
 * Retain what a published batch committed to, and stamp the reports it
 * committed.
 *
 * One mutation for both halves because they are one fact: a batch whose ordered
 * hash list was not written down is a batch nobody can open (§7.2.4), which
 * costs this observer's standing at the first challenge, and a report stamped
 * emitted without a batch row behind it is the same loss with the evidence of
 * it removed. Rows are kept, not deleted: they are still the dedupe memory
 * until retention takes them.
 */
export const commitBatches = internalMutation({
	args: {
		batches: v.array(
			v.object({
				subjectDomain: v.string(),
				windowFrom: v.string(),
				windowTo: v.string(),
				commitmentHex: v.string(),
				bundleHashes: v.array(v.string()),
				reportIds: v.array(v.id('ostrReportQueue')),
			})
		),
	},
	handler: async (ctx, args): Promise<void> => {
		const emittedAt = Date.now();
		for (const batch of args.batches) {
			const batchId = await ctx.db.insert('ostrBatchCommitments', {
				subjectDomain: batch.subjectDomain,
				windowFrom: batch.windowFrom,
				windowTo: batch.windowTo,
				commitmentHex: batch.commitmentHex,
				bundleHashes: batch.bundleHashes,
				createdAt: emittedAt,
			});
			for (const id of batch.reportIds) {
				const row = await ctx.db.get(id);
				if (row === null || row.emittedAt !== undefined) continue;
				await ctx.db.patch(id, { emittedAt, batchId });
			}
		}
	},
});

/**
 * One page of the instance's observed mailboxes — the roster the window pass
 * walks for traffic, and the §7.4 eligibility input.
 *
 * `seed` mailboxes are excluded: a deliverability seed is org infrastructure,
 * not anybody's inbox, and counting one toward the privacy floor would let an
 * operator clear a threshold that exists to protect PEOPLE by provisioning
 * robots. Suspended and deleted rows are excluded for the same reason — mail
 * they no longer receive cannot anonymize anyone.
 *
 * PAGINATED, not truncated. A roster cut off at a page boundary produces a
 * traffic denominator that covers some of the instance while `captureSpamReport`
 * accepts reports from all of it — which is precisely §7.3's "observer
 * under-attests volume to inflate a subject's complaint rate", self-inflicted.
 * The caller walks to `isDone` or refuses to publish.
 */
export const listObservedMailboxPage = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	handler: async (
		ctx,
		args
	): Promise<{ mailboxIds: Id<'mailboxes'>[]; cursor: string; isDone: boolean }> => {
		const page = await ctx.db
			.query('mailboxes')
			.withIndex('by_status', (q) => q.eq('status', 'active'))
			.paginate({ numItems: OSTR_MAILBOX_PAGE_SIZE, cursor: args.cursor });
		return {
			mailboxIds: page.page.filter((row) => row.scope !== 'seed').map((row) => row._id),
			cursor: page.continueCursor,
			isDone: page.isDone,
		};
	},
});

/**
 * How many mailboxes this instance observes, counted only as far as `limit`.
 *
 * The eligibility question is "at least N?", never "how many?", so this stops
 * as soon as the answer is yes. That matters on the report path: a bulk junk of
 * two hundred messages must not walk the whole roster two hundred times to
 * re-learn the same thing. A count short of `limit` is a real count — the walk
 * only stops early when the floor is already cleared.
 */
export const countObservedMailboxes = internalQuery({
	args: { limit: v.number() },
	handler: async (ctx, args): Promise<number> => {
		let count = 0;
		let cursor: string | null = null;
		for (let page = 0; page < OSTR_MAX_MAILBOX_PAGES; page++) {
			const result = await ctx.db
				.query('mailboxes')
				.withIndex('by_status', (q) => q.eq('status', 'active'))
				.paginate({ numItems: OSTR_MAILBOX_PAGE_SIZE, cursor });
			for (const row of result.page) {
				if (row.scope !== 'seed') count++;
			}
			if (count >= args.limit || result.isDone) break;
			cursor = result.continueCursor;
		}
		return count;
	},
});

/** One delivered message, reduced to what `MessageObservation` needs. */
export interface WindowObservation {
	mailboxId: string;
	signingDomain: string;
	isSpfPass: boolean;
	isDmarcPass: boolean;
}

/**
 * DKIM-VERIFIED messages delivered into one mailbox during the window.
 *
 * WINDOWED ON THE RECEIVER'S CLOCK. `createdAt` is stamped when this deployment
 * writes the row; `receivedAt` is the sender's own `Date:` header when it
 * supplied one. Ranging on `receivedAt` would let a spammer back-date one header
 * to fall out of every traffic summary, and a subject with no summary gets no
 * batch (§7.3's pairing rule) — so its spam reports would sit queued until
 * retention deleted them. The same header choice quietly drops honest mail that
 * was greylisted, retried, or sent by a skewed clock. `listWindowKeySightings`
 * ranges on `ostrEvidence.createdAt` for the same reason; the two agree.
 *
 * Only messages carrying a passing `d=` are returned, because only those can be
 * credited to a subject: `@owlat/ostr-observer` credits a signing domain solely
 * against a signature that verified, and the OTHER subject it would credit —
 * the connecting IP — is not on this row. The MTA holds the connection record;
 * Convex sees a delivered message. So a Convex-side observer attests domain
 * traffic and says nothing about IPs, which is the honest reading of what it
 * actually witnessed.
 */
export const listWindowObservations = internalQuery({
	args: { mailboxId: v.id('mailboxes'), fromMs: v.number(), toMs: v.number() },
	handler: async (ctx, args): Promise<WindowObservation[]> => {
		const rows = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_created', (q) =>
				q.eq('mailboxId', args.mailboxId).gte('createdAt', args.fromMs).lt('createdAt', args.toMs)
			)
			.take(OSTR_MAX_WINDOW_MESSAGES_PER_MAILBOX);
		const observations: WindowObservation[] = [];
		for (const row of rows) {
			const signingDomain = row.dkimSigningDomain;
			if (signingDomain === undefined || row.dkimResult !== 'pass') continue;
			observations.push({
				mailboxId: args.mailboxId,
				signingDomain,
				isSpfPass: row.spfResult === 'pass',
				isDmarcPass: row.dmarcResult === 'pass',
			});
		}
		return observations;
	},
});

/** The key-material half of an evidence row: what §7.5 logs about a key. */
export interface WindowKeySighting {
	signingDomain: string;
	selector: string;
	dnsKeyRecordTxt: string;
	verifiedAt: string;
}

/** Evidence captured during the window, for the key-observation pass. Reads
 *  only the four key-record fields — the signed headers stay where they are. */
export const listWindowKeySightings = internalQuery({
	args: { fromMs: v.number(), toMs: v.number() },
	handler: async (ctx, args): Promise<WindowKeySighting[]> => {
		const rows = await ctx.db
			.query('ostrEvidence')
			.withIndex('by_created_at', (q) => q.gte('createdAt', args.fromMs).lt('createdAt', args.toMs))
			.take(OSTR_MAX_WINDOW_EVIDENCE);
		return rows.map((row) => ({
			signingDomain: row.evidence.signingDomain,
			selector: row.evidence.selector,
			dnsKeyRecordTxt: row.evidence.dnsKeyRecordTxt,
			verifiedAt: row.evidence.verifiedAt,
		}));
	},
});
