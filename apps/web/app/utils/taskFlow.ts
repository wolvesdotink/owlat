/**
 * Pure helpers for the focused agent task-flow (the card-stack that shows ONE
 * task at a time and auto-advances). Ordering, time estimate, and the end-state
 * summary live here — free of Convex/Vue — so the anticipate-the-user contract
 * is unit-testable and shared by BOTH queues (personal Reply Queue and the team
 * Review Queue stay separate flows over the same helpers).
 */

/**
 * The three shapes a task can take, in the order the flow prefers them:
 *   - 'question'     — the agent needs a fact only the owner can supply
 *                      (a clarification card). Cheapest to clear, so first.
 *   - 'draft_review' — a pre-generated reply the owner reviews & sends.
 *   - 'reply'        — a plain "needs a reply from you" item with no draft.
 */
export type TaskFlowKind = 'question' | 'draft_review' | 'reply';

/** The ordering-relevant projection of a task, extracted by the caller. */
export interface TaskFlowOrderKey {
	id: string;
	kind: TaskFlowKind;
	/** Threads keep their items adjacent (answer the question, then its reply). */
	threadId?: string;
	/** Failing a thread match, items from the same person stay adjacent. */
	contactKey?: string;
}

const KIND_RANK: Record<TaskFlowKind, number> = {
	question: 0,
	draft_review: 1,
	reply: 2,
};

/** Sort weight for a task kind (questions first, plain replies last). */
export function taskFlowKindRank(kind: TaskFlowKind): number {
	return KIND_RANK[kind];
}

/**
 * Order a queue snapshot to anticipate the user:
 *   1. Seed clusters in kind order — questions before draft reviews before
 *      plain replies (a terse question is quicker to clear than a full review).
 *   2. Keep same-thread items adjacent (answer the ask, then send its reply
 *      without a context switch), then same-contact items adjacent.
 * Ties inside every choice fall back to the input order (stable), so an
 * already-ranked source (e.g. priority-then-age) keeps its relative order.
 *
 * This is a greedy clustering, not a comparator: adjacency is transitive
 * (A shares a thread with B, B shares a contact with C → A,B,C cluster), which
 * a pairwise `sort` comparator cannot express.
 */
export function orderTaskFlow<T>(items: readonly T[], key: (item: T) => TaskFlowOrderKey): T[] {
	interface Entry {
		item: T;
		key: TaskFlowOrderKey;
		index: number;
	}
	const remaining: Entry[] = items.map((item, index) => ({ item, key: key(item), index }));
	const result: Entry[] = [];

	// Lower is better: kind rank first, then original position (stable).
	const rank = (e: Entry): number => taskFlowKindRank(e.key.kind);
	const isBetter = (a: Entry, b: Entry): boolean =>
		rank(a) !== rank(b) ? rank(a) < rank(b) : a.index < b.index;

	const takeBest = (matches: (k: TaskFlowOrderKey) => boolean): Entry | null => {
		let best = -1;
		for (let i = 0; i < remaining.length; i++) {
			if (!matches(remaining[i]!.key)) continue;
			if (best === -1 || isBetter(remaining[i]!, remaining[best]!)) best = i;
		}
		return best === -1 ? null : remaining.splice(best, 1)[0]!;
	};

	while (remaining.length > 0) {
		// Seed the next cluster with the best remaining task overall.
		const seed = takeBest(() => true);
		if (!seed) break;
		result.push(seed);
		const threadIds = new Set<string>(seed.key.threadId ? [seed.key.threadId] : []);
		const contactKeys = new Set<string>(seed.key.contactKey ? [seed.key.contactKey] : []);

		// Grow the cluster: exhaust same-thread matches before same-contact, so
		// thread adjacency wins when an item shares both a thread and a contact.
		for (;;) {
			const match =
				takeBest((k) => k.threadId !== undefined && threadIds.has(k.threadId)) ??
				takeBest((k) => k.contactKey !== undefined && contactKeys.has(k.contactKey));
			if (!match) break;
			result.push(match);
			if (match.key.threadId) threadIds.add(match.key.threadId);
			if (match.key.contactKey) contactKeys.add(match.key.contactKey);
		}
	}
	return result.map((e) => e.item);
}

/** Rough per-kind time budget (seconds) used only for the "about N min" hint. */
const KIND_SECONDS: Record<TaskFlowKind, number> = {
	question: 45,
	draft_review: 60,
	reply: 120,
};

/** Sum a rough time budget for the still-pending tasks (seconds). */
export function estimateTaskFlowSeconds(kinds: readonly TaskFlowKind[]): number {
	return kinds.reduce((total, kind) => total + KIND_SECONDS[kind], 0);
}

/** Human "about 4 min" / "about 40 sec" label for a remaining-seconds budget. */
export function formatTaskFlowEstimate(seconds: number): string {
	if (seconds <= 0) return '';
	if (seconds < 90) return `about ${Math.max(1, Math.round(seconds / 15) * 15)} sec`;
	return `about ${Math.round(seconds / 60)} min`;
}

/** One tallied outcome for the end-state summary, e.g. { label: 'answered', count: 3 }. */
export interface TaskFlowTally {
	label: string;
	count: number;
}

/**
 * The end-state summary line, e.g. "3 answered · 2 approved". Outcomes are
 * joined in the order they were first recorded; zero-count entries drop out.
 */
export function summarizeTaskFlow(tally: readonly TaskFlowTally[]): string {
	return tally
		.filter((t) => t.count > 0)
		.map((t) => `${t.count} ${t.label}`)
		.join(' · ');
}
