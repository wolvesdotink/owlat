/**
 * Which code-worker callbacks may still move a code task.
 *
 * A run is identified by its claim: `claim` counts the attempt and hands the
 * number to the worker, which sends it back on every later call. A callback is
 * accepted only while the task is still in a worker-owned status, was not
 * cancelled, and still belongs to that attempt. Anything else is answered with
 * the reason instead of a patch, so a run that outlived its claim (the user
 * cancelled it, or a reclaim requeued it and a newer attempt took over) stops
 * instead of overwriting a terminal or newer state.
 *
 * Pure so the rule can be tested on its own; the mutations read the row and
 * apply the verdict.
 */
import type { Doc } from '../_generated/dataModel';

/** Statuses in which the code-worker (not the user) owns the task. */
export const WORKER_OWNED_STATUSES = ['running', 'testing'] as const;

type CodeTaskStatus = Doc<'codeWorkTasks'>['status'];

function isWorkerOwned(status: CodeTaskStatus): boolean {
	return (WORKER_OWNED_STATUSES as readonly CodeTaskStatus[]).includes(status);
}

/**
 * Why a worker callback was refused: the row is gone, the user cancelled it, a
 * newer attempt owns it, or it already left the worker-owned statuses.
 */
export type CodeTaskStopReason = 'missing' | 'cancelled' | 'stale' | 'finished';

export type CodeTaskWorkerVerdict = { ok: true } | { ok: false; reason: CodeTaskStopReason };

/**
 * `attempt` is undefined only for a call from the previous release's worker,
 * which still gets the cancellation and status checks.
 */
export function codeTaskWorkerVerdict(
	task: Pick<Doc<'codeWorkTasks'>, 'status' | 'attempts' | 'cancelledAt'> | null,
	attempt: number | undefined
): CodeTaskWorkerVerdict {
	if (!task) return { ok: false, reason: 'missing' };
	if (task.cancelledAt !== undefined) return { ok: false, reason: 'cancelled' };
	if (attempt !== undefined && (task.attempts ?? 0) !== attempt) {
		return { ok: false, reason: 'stale' };
	}
	if (!isWorkerOwned(task.status)) return { ok: false, reason: 'finished' };
	return { ok: true };
}
