/**
 * Waiting runs (helper): the runs of an automation whose email step waits for
 * the sending setup to be fixed (`configurationWait.ts`), read for the
 * automations list, the detail header and the runs panel's `waiting` filter.
 *
 * A waiting step run is `pending` with `waitingFor` set, and the read goes
 * through `automationStepRuns.by_step_status_waiting_for` from the
 * automation's email steps, so it is one bounded range per email step. It
 * is read, not counted by the write path: a run stops waiting through the
 * claim, a release, the give-up firing, a closed gate (paused or deleted
 * automation, deleted contact) and run deletion, and every one of those
 * already moves the step run's status, so the index can never disagree with
 * the rows. Step runs that waited before the index existed are in it too,
 * with no backfill. The price is a cap: past {@link WAITING_COUNT_CAP} the
 * count reads as "at least".
 *
 * A step run that a re-check or a release has claimed is `executing` for the
 * moment of that attempt and is not counted, as the runs panel does not show
 * it as waiting either.
 */

import type { DatabaseReader } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { AutomationStepWaitReason } from '../lib/validators/automations';
import { loadOrderedSteps } from './steps';

/** Waiting runs one automation's count reads before it reads as "at least". */
export const WAITING_COUNT_CAP = 50;

/**
 * Email-step ranges one `summaries` call may open for waiting runs, shared
 * evenly by the automations it answers for. With the call's other reads (a
 * handful per automation, at most 100 automations) it stays well inside
 * Convex's per-function limit of 4,096 index ranges, however many email steps
 * the automations have.
 */
export const WAITING_STEP_RANGES_PER_CALL = 2000;

/** One wait reason's share of an automation's waiting runs. */
export interface WaitingReasonCount {
	reason: AutomationStepWaitReason;
	count: number;
	/** The earliest give-up among the counted runs. */
	until: number;
}

export interface WaitingRunsSummary {
	/** Waiting runs counted, at most {@link WAITING_COUNT_CAP}. */
	count: number;
	/** More runs wait than were counted. */
	hasMore: boolean;
	/** Most runs first. */
	reasons: WaitingReasonCount[];
}

async function emailStepIdsOf(
	db: DatabaseReader,
	automationId: Id<'automations'>
): Promise<Id<'automationSteps'>[]> {
	const steps = await loadOrderedSteps(db, automationId);
	return steps.filter((step) => step.stepType === 'email').map((step) => step._id);
}

/**
 * One email step's waiting step runs: one index range for every reason (a
 * defined `waitingFor` sorts above the absent one), so a list page opens one
 * range per email step and stays far inside the per-function range limit.
 * Ordered by reason, then by creation.
 */
function waitingOn(db: DatabaseReader, stepId: Id<'automationSteps'>) {
	return db
		.query('automationStepRuns')
		.withIndex('by_step_status_waiting_for', (q) =>
			q.eq('automationStepId', stepId).eq('status', 'pending').gt('waitingFor', undefined)
		);
}

/**
 * The automation's waiting runs by reason, or null when none waits. Reads at
 * most `maxSteps` email steps; an automation with more reads as "at least"
 * (`hasMore`) for the runs counted so far.
 */
export async function summarizeWaitingRuns(
	db: DatabaseReader,
	automationId: Id<'automations'>,
	maxSteps: number = WAITING_STEP_RANGES_PER_CALL
): Promise<WaitingRunsSummary | null> {
	const allStepIds = await emailStepIdsOf(db, automationId);
	const stepIds = allStepIds.slice(0, maxSteps);
	const byReason = new Map<AutomationStepWaitReason, WaitingReasonCount>();
	let count = 0;
	let hasMore = false;
	for (const stepId of stepIds) {
		const left = WAITING_COUNT_CAP - count;
		const rows = await waitingOn(db, stepId).take(left + 1);
		if (rows.length > left) hasMore = true;
		for (const row of rows.slice(0, left)) {
			if (row.waitingFor === undefined) continue;
			count++;
			const entry = byReason.get(row.waitingFor);
			byReason.set(row.waitingFor, {
				reason: row.waitingFor,
				count: (entry?.count ?? 0) + 1,
				until: Math.min(entry?.until ?? Infinity, row.waitingUntil ?? Infinity),
			});
		}
		if (hasMore) break;
	}
	if (allStepIds.length > stepIds.length) hasMore = true;
	if (count === 0 && !hasMore) return null;
	const reasons = [...byReason.values()].sort((a, b) => b.count - a.count);
	return { count, hasMore, reasons };
}

/**
 * The first `take` waiting step runs of the automation in one fixed order (by
 * reason, then newest first), the order the runs panel's `waiting` filter
 * pages through. Each step's range is read in that same order, so the first
 * `take` of the merge are the first `take` overall and a later page continues
 * the earlier one.
 */
export async function newestWaitingStepRuns(
	db: DatabaseReader,
	automationId: Id<'automations'>,
	take: number
): Promise<Doc<'automationStepRuns'>[]> {
	const stepIds = await emailStepIdsOf(db, automationId);
	const rows: Doc<'automationStepRuns'>[] = [];
	for (const stepId of stepIds) {
		rows.push(...(await waitingOn(db, stepId).order('desc').take(take)));
	}
	return rows
		.sort((a, b) => {
			// Code-unit order, as the index orders strings.
			const byReason = (a.waitingFor ?? '') < (b.waitingFor ?? '') ? 1 : -1;
			return a.waitingFor === b.waitingFor ? b._creationTime - a._creationTime : byReason;
		})
		.slice(0, take);
}
