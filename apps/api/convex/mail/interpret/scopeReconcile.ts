/**
 * Per-row reconciliation of a narrowed read: what a message's old read
 * contributed to its thread is withdrawn, and everything else stays.
 *
 * A re-verified signature can narrow what a message may be read for (a
 * clearsigned scope: the signed block only, `mail/mailbox/signatureReverify.ts`).
 * The old read saw the unsigned text around it, and every claim it made was
 * made with that text in view, so the read is withdrawn whole: in the
 * transaction that applies the scope the thread is fenced (`staleFence.ts`),
 * its deletion epoch bumped (an in-flight run of any of its messages is
 * `erased`), and its one `withdraw` job (`threadPurgeJobs`, keyed per thread,
 * walked a page at a time by `purgeDrain.ts`) is started or, while one runs,
 * restarted with the new reads added. The fence holds until the walk has
 * reconciled every row, however many the thread has:
 *
 *  0. a thread fenced without saying which message narrowed (an earlier
 *     release's fence, migration 0070) has its messages paged first: each
 *     one whose current read no longer matches its stored body fingerprint
 *     joins the withdrawn reads, and nothing below runs before the last page;
 *  1. the old reads' extractions go (their latest lines, facts, waiting
 *     transitions and exact-wording flag with them; nothing can replay them);
 *  2. the reducer's activity rows of those reads go (`interp:<source>:…`);
 *  3. items: one whose every quote came from a withdrawn read is WITHDRAWN
 *     ({@link withdrawItem}), never deleted; one that other messages support
 *     too is stripped like a purge does (`purgeClaims.ts stripItem`): the
 *     withdrawn read's quotes go, the fields it set are redacted to
 *     {@link WITHDRAWN_CLAIM_TEXT}, what it set as status or disposition
 *     reverts, and its held changes go;
 *  4. facts: one supported only by a withdrawn read is deleted (facts carry
 *     no human state), a survivor is redacted;
 *  5. response plans go stale; claim records lose the deleted facts;
 *  6. the fence lifts (unless the walk has no withdrawn read at all: a scan
 *     that found none leaves the thread fenced for the operator,
 *     `staleFence:release`): the needs-reply flag loses what the model derived
 *     (the Daily Brief subtitle reads it), a gist from a withdrawn read goes,
 *     and the withdrawn messages wait for the thread's next open to be read
 *     again under their new scope (deferred, `scope_reread`, `lazy.ts`);
 *  7. sources whose claims lost fields are re-read (`purgeQuestions.ts
 *     reinterpretRange`), so a verified claim refills them;
 *
 * and settling recomputes the brief and its list projection like a purge.
 *
 * A withdrawn item keeps its wording, status, reminder and assignee for the
 * person, reads `verify: 'proposal'` (so the to-do list, plans, nudges,
 * "elsewhere" and the list projection pass it by), and holds what it was
 * trusted as before in `withdrawal`, the person's confirmation included. The
 * model never sees it, the reducer folds nothing into it, no pending
 * transition matches it and nobody can confirm it. Only a verified claim of a
 * read of the same message that restates every field the machine reads (the
 * wording, and the deadline, amount and options it had) restores it
 * ({@link restoreWithdrawn}); the confirmation comes back with it.
 *
 * Isolate-safe helpers, no Convex functions apart from the deferral a fenced
 * run asks for.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { internalMutation } from '../../lib/writeFence';
import {
	interpretationSourceKey,
	interpretationSourceValidator,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { openMessageBody, sealBodyAtWrite } from '../../lib/messageBody';
import { scopedIdempotencyKey } from './activity';
import { writeItemChange } from './counters';
import { sourcesOfClaim } from './heldSources';
import { counterpartyKeyOf, responsibilityOf } from './parties';
import {
	claimRecordsRange,
	extractionsRange,
	factsRange,
	itemsAfter,
	mailMessageSources,
	plansRange,
	purgedOf,
} from './purge';
import {
	stripItem,
	transitionReset,
	WITHDRAWN_CLAIM_TEXT,
	type PurgedSources,
} from './purgeClaims';
import {
	createPurgeJob,
	drainShrinking,
	drainSteps,
	findPurgeJob,
	scanRange,
	type DrainBudget,
	type JobPlan,
	type PurgeRange,
} from './purgeDrain';
import { reinterpretRange, settleSourcesJob } from './purgeQuestions';
import { bumpDeletionEpoch } from './purgeRows';
import { deferSource, isSourceDeferred, settleSource } from './outstanding';
import { clearGistOf } from './gistState';
import { fenceThreadInterpretation, withoutInterpretationCache } from './staleFence';
import { narrowedReadsRange } from './scopeScan';
import { logInfo } from '../../lib/runtimeLog';
import type { ReduceItem, ReduceResult } from './reduceInput';

/** A message's withdrawn items a restore considers (one read yields far fewer). */
const RESTORE_SCAN = 100;

function jobKeyOf(threadId: Id<'mailThreads'>): string {
	return `withdraw:${threadId}`;
}

/**
 * The read of `messageId` no longer holds: fence its thread and withdraw what
 * the read contributed (see the module doc). Call in the transaction that
 * applies the narrower scope. A walk already running for the thread starts
 * over with this read added; its continuation is still scheduled.
 */
export async function startScopeReconcile(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	messageId: Id<'mailMessages'>
): Promise<void> {
	await startWithdraw(ctx, threadId, { sources: mailMessageSources(messageId) });
}

/**
 * A fenced thread whose narrowed messages are not known: its walk pages every
 * message for reads that no longer hold before it withdraws anything (step 0
 * of the module doc).
 */
export async function startFencedThreadScan(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<void> {
	await startWithdraw(ctx, threadId, { sources: [], isScanNeeded: true });
}

async function startWithdraw(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	start: { sources: InterpretationSource[]; isScanNeeded?: boolean }
): Promise<void> {
	const ref: ThreadRef = { kind: 'mail', id: threadId };
	await fenceThreadInterpretation(ctx, threadId);
	await bumpDeletionEpoch(ctx, ref);
	const job = await findPurgeJob(ctx, jobKeyOf(threadId));
	if (job) {
		const known = new Set((job.sources ?? []).map(interpretationSourceKey));
		const added = start.sources.filter((s) => !known.has(interpretationSourceKey(s)));
		await ctx.db.patch(job._id, {
			sources: [...(job.sources ?? []), ...added],
			...(start.isScanNeeded ? { isScanNeeded: true } : {}),
			rangeIndex: 0,
			cursor: undefined,
			updatedAt: Date.now(),
		});
		return;
	}
	const created = await createPurgeJob(ctx, {
		ref,
		kind: 'withdraw',
		sources: start.sources,
		jobKey: jobKeyOf(threadId),
		...(start.isScanNeeded ? { isScanNeeded: true } : {}),
	});
	await ctx.scheduler.runAfter(0, internal.mail.interpret.purgeJobs.continueJob, {
		jobId: created._id,
	});
}

/** The withdrawn read's message an item's quotes name, if any. */
function withdrawnMessageOf(
	item: Pick<Doc<'threadItems'>, 'evidence'>,
	purged: PurgedSources
): Id<'mailMessages'> | null {
	const hit = item.evidence.find((e) => purged.ids.has(e.source.id));
	if (!hit || (hit.source.kind !== 'mail' && hit.source.kind !== 'outboundMail')) return null;
	return hit.source.id;
}

/**
 * Reconcile one item with the withdrawn reads: withdrawn when they were its
 * only support, stripped and redacted when other messages support it too.
 */
export async function withdrawItem(
	ctx: MutationCtx,
	ref: ThreadRef,
	item: Doc<'threadItems'>,
	purged: PurgedSources,
	budget: DrainBudget
): Promise<'untouched' | 'withdrawn' | 'survived'> {
	if (item.withdrawal) return 'untouched';
	const messageId = withdrawnMessageOf(item, purged);
	const isSolelyWithdrawn =
		messageId !== null && item.evidence.every((e) => purged.ids.has(e.source.id));
	if (!isSolelyWithdrawn) {
		const fate = await stripItem(ctx, ref, item, purged, budget, { text: WITHDRAWN_CLAIM_TEXT });
		return fate === 'survived' ? 'survived' : 'untouched';
	}
	const isConfirmed = item.correction?.kind === 'confirmed';
	const now = Date.now();
	await writeItemChange(ctx, ref, item, {
		// A status or disposition the withdrawn read set reverts; a person's stays.
		...transitionReset(item, purged),
		evidence: [],
		pendingUpdate: undefined,
		confirmedFrom: undefined,
		...(isConfirmed ? { correction: undefined } : {}),
		verify: 'proposal',
		isReviewNeeded: true,
		withdrawal: {
			at: now,
			messageId,
			verify: item.verify,
			...(isConfirmed ? { confirmation: item.correction } : {}),
			...(item.isReviewNeeded !== undefined ? { isReviewNeeded: item.isReviewNeeded } : {}),
		},
		revision: item.revision + 1,
		updatedAt: now,
	});
	return 'withdrawn';
}

/** 2. The reducer's activity rows of the withdrawn reads (`interp:<source>:…`). */
const withdrawnActivityRange: PurgeRange = (ctx, { ref, cursor, budget, state }) =>
	drainSteps(
		budget,
		cursor,
		[...purgedOf(state).keys].map((key) => () => {
			const prefix = scopedIdempotencyKey(ref, `interp:${key}:`);
			return drainShrinking(
				budget,
				(n) =>
					ctx.db
						.query('threadActivity')
						.withIndex('by_idempotency_key', (q) =>
							q.gte('idempotencyKey', prefix).lte('idempotencyKey', `${prefix}￿`)
						)
						.take(n),
				async (row) => {
					await ctx.db.delete(row._id);
					return true;
				}
			);
		})
	);

/** 3. The thread's items: withdrawn, or stripped and redacted. */
const withdrawItemsRange: PurgeRange = (ctx, run) => {
	const purged = purgedOf(run.state);
	return scanRange(
		run.budget,
		run.cursor,
		(after, n) => itemsAfter(ctx, run.ref, after, n),
		(row) => row._creationTime,
		async (item) => {
			const fate = await withdrawItem(ctx, run.ref, item, purged, run.budget);
			if (fate === 'untouched') return true;
			run.state.isClaimChanged = true;
			if (fate === 'survived') run.state.isSurvivorChanged = true;
			return true;
		}
	);
};

/**
 * 6. Lift the fence: every row is reconciled. What the model derived for the
 * needs-reply flag goes until a new read recomputes it, a gist read from a
 * withdrawn source goes, and the withdrawn messages wait for the next open.
 */
const liftRange: PurgeRange = async (ctx, { ref, state }) => {
	if (ref.kind !== 'mail') return { isDone: true };
	const thread = await ctx.db.get(ref.id);
	if (!thread) return { isDone: true };
	if (state.sources.length === 0) {
		// A scan found no read that no longer holds: what the fence hides is not
		// known to be safe, so it stays for the operator (`staleFence:release`).
		logInfo('mail.interpret.scope_reconcile.unresolved', { threadId: ref.id });
		return { isDone: true };
	}
	for (const key of purgedOf(state).keys) {
		await clearGistOf(ctx, ref, key);
		await deferSource(ctx, key, 'scope_reread');
	}
	await ctx.db.patch(ref.id, {
		interpretationStaleSince: undefined,
		...(thread.needsReply ? { needsReply: withoutInterpretationCache(thread.needsReply) } : {}),
	});
	// The arrival projection reads the fence: re-place the thread (as `release` does).
	await ctx.scheduler.runAfter(0, internal.mail.senders.resortChain.continueResort, {
		threadIds: [ref.id],
	});
	return { isDone: true };
};

/** The walk of a `withdraw` job (see the module doc); it settles like a purge. */
export const withdrawPlan: JobPlan = {
	ranges: [
		narrowedReadsRange,
		extractionsRange,
		withdrawnActivityRange,
		withdrawItemsRange,
		factsRange,
		plansRange,
		claimRecordsRange,
		liftRange,
		reinterpretRange,
	],
	settle: settleSourcesJob,
};

/**
 * A run of a fenced thread's source reads nothing (`runOnce.ts`): the source
 * waits for the thread's next open, so the reads the fence held back happen
 * once the reconciliation lifted it. A source already waiting keeps its
 * deferral (the lift re-defers only the withdrawn messages, so settling it
 * would drop it from the re-read queue). A source that cannot wait (no
 * Postbox message behind it) is settled instead.
 */
export const deferFencedSource = internalMutation({
	args: { source: interpretationSourceValidator },
	returns: v.null(),
	handler: async (ctx, args) => {
		const key = interpretationSourceKey(args.source);
		if (await isSourceDeferred(ctx, key)) return null;
		if (!(await deferSource(ctx, key, 'scope_reread'))) await settleSource(ctx, key, 'recorded');
		return null;
	},
});

// ── Restore ────────────────────────────────────────────────────────────────

function words(text: string): string {
	return text
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function sameOptions(a: readonly string[], b: readonly string[] | undefined): boolean {
	if (!b || a.length !== b.length) return false;
	const set = new Set(a.map(words));
	return b.every((o) => set.has(words(o)));
}

/**
 * Does `claim` restate every field of the withdrawn item the machine reads?
 * Its wording (word for word), and each of the deadline, amount and options
 * the item had. Pure.
 */
export function restatesWithdrawn(
	item: Pick<Doc<'threadItems'>, 'intent' | 'due' | 'amount' | 'options'> & { text: string },
	claim: Pick<ReduceItem, 'intent' | 'assertion' | 'due' | 'amount' | 'options' | 'verify'>
): boolean {
	if (claim.verify !== 'passed' || claim.intent !== item.intent) return false;
	if (words(claim.assertion) !== words(item.text)) return false;
	if (item.due) {
		if (!claim.due) return false;
		const isSameAt = item.due.at !== undefined && item.due.at === claim.due.at;
		if (!isSameAt && (item.due.at !== undefined || item.due.phrase !== claim.due.phrase)) {
			return false;
		}
	}
	if (item.amount && !sameJson(item.amount, claim.amount)) return false;
	if (item.options?.length && !sameOptions(item.options, claim.options)) return false;
	return true;
}

async function sealedPair(text: { en: string; de: string }) {
	return { en: await sealBodyAtWrite(text.en), de: await sealBodyAtWrite(text.de) };
}

/**
 * Before a read of a mail message is folded in: restore each of the message's
 * withdrawn items that one of the read's verified claims restates in full
 * ({@link restatesWithdrawn}). The item takes the claim's fields, its earlier
 * trust and the person's confirmation back, and the claim is pointed at it,
 * so the fold merges its quotes. Returns the result the fold takes.
 */
export async function restoreWithdrawn(
	ctx: MutationCtx,
	ref: ThreadRef,
	entry: { source: InterpretationSource; sourceKey: string; sourceAt: number; result: ReduceResult }
): Promise<ReduceResult> {
	const { source } = entry;
	if (ref.kind !== 'mail' || (source.kind !== 'mail' && source.kind !== 'outboundMail')) {
		return entry.result;
	}
	const rows = await ctx.db
		.query('threadItems')
		.withIndex('by_mail_thread_withdrawn', (q) =>
			q.eq('mailThreadId', ref.id).eq('withdrawal.messageId', source.id)
		)
		.take(RESTORE_SCAN);
	if (rows.length === 0) return entry.result;
	const candidates = await Promise.all(
		rows.map(async (row) => ({ row, text: await openMessageBody(row.assertion) }))
	);
	const taken = new Set<string>();
	const items: ReduceItem[] = [];
	for (const claim of entry.result.items) {
		const match = candidates.find(
			(c) => !taken.has(c.row._id) && restatesWithdrawn({ ...c.row, text: c.text }, claim)
		);
		if (!match) {
			items.push(claim);
			continue;
		}
		taken.add(match.row._id);
		await restoreItem(ctx, ref, match.row, claim, {
			sourceKey: entry.sourceKey,
			at: entry.sourceAt,
		});
		items.push({ ...claim, matchItemId: match.row._id });
	}
	return { ...entry.result, items };
}

async function restoreItem(
	ctx: MutationCtx,
	ref: ThreadRef,
	row: Doc<'threadItems'>,
	claim: ReduceItem,
	setBy: { sourceKey: string; at: number }
): Promise<void> {
	const withdrawal = row.withdrawal!;
	const confirmation = withdrawal.confirmation;
	await writeItemChange(ctx, ref, row, {
		withdrawal: undefined,
		verify: withdrawal.verify,
		// The person's confirmation, unless they corrected the item since.
		...(confirmation && row.correction === undefined ? { correction: confirmation } : {}),
		isReviewNeeded: withdrawal.isReviewNeeded,
		intent: claim.intent,
		facets: claim.facets,
		consequences: claim.consequences,
		assertion: await sealBodyAtWrite(claim.assertion),
		display: await sealedPair(claim.display),
		requester: claim.requester,
		responsible: claim.responsible,
		beneficiary: claim.beneficiary,
		responsibility: responsibilityOf(claim.responsible),
		counterpartyKey: counterpartyKeyOf(claim),
		due: claim.due,
		amount: claim.amount,
		options: claim.options,
		fieldSources: sourcesOfClaim(claim, setBy),
		redactedFields: undefined,
		revision: row.revision + 1,
		updatedAt: Date.now(),
	});
}
