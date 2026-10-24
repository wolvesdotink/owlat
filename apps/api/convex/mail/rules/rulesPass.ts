/**
 * Read on arrival: ONE evaluation algebra for plain-language, Fix
 * and AI-conditioned filters, behind the three rules hooks
 * (`mail/arrival/hooks.ts`).
 *
 * THE HOOK PASS ({@link runArrivalRulesPass}) runs once per live inbound
 * message, from each live-ingest path right after `insertDeliveredMessage`
 * (hosted MX and external sync; never a history import or backfill). It
 * evaluates only the hook filters (`filterValidation.ts isHookFilter`); the
 * hosted manual pre-insert pass is unchanged and hands over what it applied.
 * In priority order:
 *
 *   1. A filter WITHOUT an AI condition is evaluated now. On a match its
 *      actions are planned and its `stopProcessing` stops the later hook
 *      filters. A manual filter that stopped processing stops every hook
 *      filter after it too.
 *   2. A filter WITH an AI condition evaluates its deterministic part (none
 *      counts as matched). On a match `{filterId, revision, question}` goes
 *      into the record's `pendingAiFilters`, at most 5, highest priority
 *      first. Its actions wait for R2. It cannot stop processing (the save
 *      validator refuses that), so its late answer changes nothing another
 *      filter does.
 *
 * The pass also runs the opt-in code detector (`archiveAfter 24h` for
 * one-time codes and sign-in links). Its result seeds the arrival record,
 * which `runPostInsertInboundEffects` writes in the same mutation.
 *
 * THE ANSWERS ({@link applyRuleAnswers}) commit R2's per-message answers:
 * revision-checked against the pending entry and the filter, true answers
 * applied in priority order under `exclusiveWinners`, every answer recorded
 * in `filterMatches` (an unknown or failed answer is no match), the projection
 * refreshed. Idempotent: an answered question is no longer pending.
 *
 * Isolate-safe; not a Convex function.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { isPersonalMailbox } from '../permissions';
import { isFromMailboxOwner } from '../needsReplyHeuristic';
import { evalMessageFromRow, filterConditionsMatch } from '../filtersEval';
import { isHookFilter } from '../filterValidation';
import { isCodeOrSignInMail } from '../interpret/eligibility';
import { loadArrivalRecord } from '../arrival/records';
import { refreshArrivalProjection } from '../arrival/projection';
import { isFencedThread } from '../interpret/staleFence';
import type { ManualPassOutcome } from '../deliveryPipeline/routing';
import type { InboundOrigin } from '../deliveryPipeline/insert';
import { addFilterToPlan, commitRulePlan, emptyRulePlan, type ExclusiveWinners } from './ruleApply';
import { createDelayedArchive } from './delayedActions';

/** Pending AI questions one message carries (§6.2 rule 3; the UI states the limit). */
export const MAX_PENDING_AI_FILTERS = 5;

/** The code detector archives after a day (§6.4). */
export const CODE_ARCHIVE_HOURS = 24;

/** Folders whose mail the hook pass leaves alone. */
const UNEVALUATED_ROLES: ReadonlySet<string> = new Set(['spam', 'trash', 'sent', 'drafts']);

type ArrivalRecord = Doc<'mailArrivalRecords'>;
type FilterMatch = NonNullable<ArrivalRecord['filterMatches']>[number];
type PendingAiFilter = NonNullable<ArrivalRecord['pendingAiFilters']>[number];

/** What the hook pass hands the arrival record (and the delayed rows it made). */
export interface ArrivalRulesSeed {
	pendingAiFilters: PendingAiFilter[];
	rulePlacement?: ArrivalRecord['rulePlacement'];
	delayedActions: Id<'mailDelayedActions'>[];
	exclusiveWinners?: ExclusiveWinners;
	filterMatches?: FilterMatch[];
	lastOperationId?: Id<'mailArrivalOperations'>;
}

/** The revision an AI answer binds to. */
export function filterRevision(filter: Pick<Doc<'mailFilters'>, 'revision'>): number {
	return filter.revision ?? 0;
}

/** Whether the owner turned the code detector on (absent = off). */
async function isCodeAutoArchiveOn(ctx: Pick<QueryCtx, 'db'>, userId: string): Promise<boolean> {
	const row = await ctx.db
		.query('mailUserSettings')
		.withIndex('by_user', (q) => q.eq('userId', userId))
		.first();
	return row?.isCodeAutoArchiveOn === true;
}

function withWinners(seed: ArrivalRulesSeed, winners: ExclusiveWinners): ArrivalRulesSeed {
	return Object.keys(winners).length > 0 ? { ...seed, exclusiveWinners: winners } : seed;
}

/** The hook pass of one live inbound message (see the module doc). */
export async function runArrivalRulesPass(
	ctx: MutationCtx,
	args: {
		message: Doc<'mailMessages'>;
		mailboxId: Id<'mailboxes'>;
		origin: Exclude<InboundOrigin, 'backfill'>;
		manualPass?: ManualPassOutcome;
	}
): Promise<ArrivalRulesSeed> {
	const { message } = args;
	const winners: ExclusiveWinners = { ...args.manualPass?.winners };
	const seed: ArrivalRulesSeed = { pendingAiFilters: [], delayedActions: [] };
	const mailbox = await ctx.db.get(args.mailboxId);
	// Arrival rows exist only for live mail from others in a personal mailbox.
	if (!mailbox || !isPersonalMailbox(mailbox) || message.mailboxId !== mailbox._id) return seed;
	if (isFromMailboxOwner(message, mailbox.address)) return seed;
	const folder = await ctx.db.get(message.folderId);
	if (folder?.role !== undefined && UNEVALUATED_ROLES.has(folder.role)) {
		return withWinners(seed, winners);
	}

	const stoppedAt = args.manualPass?.stoppedAtPriority;
	const filters = (
		await ctx.db
			.query('mailFilters')
			.withIndex('by_mailbox_and_priority', (q) => q.eq('mailboxId', mailbox._id))
			.collect()
	) // bounded: one mailbox's filters
		.filter(
			(filter) =>
				filter.isEnabled &&
				isHookFilter(filter) &&
				(stoppedAt === undefined || filter.priority < stoppedAt)
		);
	const isCodeDetectorOn = await isCodeAutoArchiveOn(ctx, mailbox.userId);
	if (filters.length === 0 && !isCodeDetectorOn) return withWinners(seed, winners);

	const evalMessage = await evalMessageFromRow(ctx.db, message);
	const plan = emptyRulePlan();
	const matches: FilterMatch[] = [];
	for (const filter of filters) {
		const isMatched =
			filter.conditions.length === 0
				? filter.aiCondition !== undefined
				: filterConditionsMatch(filter, evalMessage);
		if (!isMatched) continue;
		const revision = filterRevision(filter);
		if (filter.aiCondition) {
			if (seed.pendingAiFilters.length < MAX_PENDING_AI_FILTERS) {
				seed.pendingAiFilters.push({
					filterId: filter._id,
					revision,
					question: filter.aiCondition.question,
				});
			}
			continue;
		}
		matches.push({ filterId: filter._id, revision, pass: 'deterministic' });
		addFilterToPlan(plan, winners, filter, 'hook');
		if (filter.stopProcessing) break;
	}

	const now = Date.now();
	const commit = await commitRulePlan(ctx, {
		messageId: message._id,
		plan,
		winners,
		isLate: false,
		placementBefore: null,
		now,
	});
	seed.delayedActions.push(...commit.delayedActions);
	if (commit.rulePlacement) seed.rulePlacement = commit.rulePlacement;
	// The ABA guard of the placement change row (§4.4), stamped with it.
	if (commit.rulePlacement && commit.operationId) seed.lastOperationId = commit.operationId;
	if (matches.length > 0) seed.filterMatches = matches;

	if (isCodeDetectorOn) {
		const current = await ctx.db.get(message._id);
		const text = `${evalMessage.bodyText ?? ''}`;
		if (current && isCodeOrSignInMail({ subject: current.subject, text })) {
			const delayed = await createDelayedArchive(ctx, {
				message: current,
				hours: CODE_ARCHIVE_HOURS,
				source: 'code_detector',
				now,
			});
			if (delayed) seed.delayedActions.push(delayed);
		}
	}
	return withWinners(seed, winners);
}

/** The pending AI questions of ONE message (read from its arrival record). */
export async function listPendingRuleQuestions(
	ctx: Pick<QueryCtx, 'db'>,
	args: { mailboxId: Id<'mailboxes'>; messageId: Id<'mailMessages'> }
): Promise<PendingAiFilter[]> {
	const record = await loadArrivalRecord(ctx, args.messageId);
	if (!record || record.mailboxId !== args.mailboxId) return [];
	return record.pendingAiFilters ?? [];
}

/** Commit R2's answers for ONE message (see the module doc). */
export async function applyRuleAnswers(
	ctx: MutationCtx,
	args: {
		messageId: Id<'mailMessages'>;
		answers: { filterId: Id<'mailFilters'>; revision: number; answer: boolean | null }[];
	}
): Promise<void> {
	const record = await loadArrivalRecord(ctx, args.messageId);
	const message = await ctx.db.get(args.messageId);
	if (!record || !message || record.mailboxId !== message.mailboxId) return;
	// Re-checked in this transaction: a mailbox that went shared writes no rule
	// rows at all (its drain removes them), and a fenced thread's answer came
	// from text the fence now distrusts, so it counts as unknown (no match).
	const mailbox = await ctx.db.get(record.mailboxId);
	if (!mailbox || !isPersonalMailbox(mailbox)) return;
	const isFenced = isFencedThread(await ctx.db.get(message.threadId));
	const pending = record.pendingAiFilters ?? [];
	const answered = new Set<Id<'mailFilters'>>();
	const matches: FilterMatch[] = [];
	const matched: Doc<'mailFilters'>[] = [];
	for (const answer of args.answers) {
		const entry = pending.find(
			(p) => p.filterId === answer.filterId && p.revision === answer.revision
		);
		if (!entry || answered.has(entry.filterId)) continue;
		answered.add(entry.filterId);
		const filter = await ctx.db.get(entry.filterId);
		// Edited (a new revision), disabled, deleted or no longer AI: no match.
		const isCurrent =
			filter !== null &&
			filter.mailboxId === record.mailboxId &&
			filter.isEnabled &&
			filter.aiCondition !== undefined &&
			filterRevision(filter) === entry.revision;
		matches.push({
			filterId: entry.filterId,
			revision: entry.revision,
			pass: 'ai',
			answer: isCurrent && !isFenced ? answer.answer : null,
		});
		if (isCurrent && !isFenced && answer.answer === true) matched.push(filter);
	}
	if (answered.size === 0) return;

	const winners: ExclusiveWinners = { ...record.exclusiveWinners };
	const plan = emptyRulePlan();
	for (const filter of matched.sort((a, b) => a.priority - b.priority)) {
		addFilterToPlan(plan, winners, filter, 'ai');
	}
	const commit = await commitRulePlan(ctx, {
		messageId: message._id,
		plan,
		winners,
		isLate: true,
		placementBefore: record.rulePlacement ?? null,
		now: Date.now(),
	});
	const remaining = pending.filter((p) => !answered.has(p.filterId));
	await ctx.db.patch(record._id, {
		pendingAiFilters: remaining.length > 0 ? remaining : undefined,
		filterMatches: [...(record.filterMatches ?? []), ...matches],
		...(Object.keys(winners).length > 0 ? { exclusiveWinners: winners } : {}),
		...(commit.rulePlacement
			? { rulePlacement: commit.rulePlacement, lastOperationId: commit.operationId ?? undefined }
			: {}),
		updatedAt: Date.now(),
	});
	await refreshArrivalProjection(ctx, record.threadId);
}
