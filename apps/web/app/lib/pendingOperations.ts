/**
 * The writes that are still waiting for the server, app-wide.
 *
 * `useBackendOperation` registers every mutation run here and settles it when
 * the call returns. A run still unanswered after {@link SLOW_OPERATION_MS} is
 * counted in {@link slowOperationCount}, which the shell turns into one
 * "saving is taking longer than usual" notice. Runs are tracked by their own
 * id, not by an operation's loading flag, so overlapping runs of the same
 * operation settle independently.
 *
 * A slow episode starts when the first run turns slow and ends once nothing at
 * all has been pending for {@link EPISODE_QUIET_MS}. Its outcome is `saved`
 * only if every run and hold settled in that time succeeded and no other queue
 * still holds unsaved work; a failure has its own error surface already, so
 * the episode then ends without a success message.
 *
 * Bulk actions and parallel uploads register many runs at once, so nothing
 * here costs more than O(1) per registration, settle or threshold crossing:
 * one shared timer marks every run that is due in one pass, the published
 * state is a counter, and labels are resolved only when the Details list is
 * actually read.
 */
import { computed, shallowRef } from 'vue';

/** How long a write may take before the shell says it is slow. */
export const SLOW_OPERATION_MS = 5_000;

/**
 * How long nothing may be pending before a slow episode is over. A save made
 * of several calls (mint an upload URL, send the file, register it) is idle
 * for a moment between two of them; deciding at the first idle instant would
 * confirm "all changes saved" before the next step has even started.
 */
export const EPISODE_QUIET_MS = 1_000;

export interface SlowOperation {
	id: number;
	/** The operation's label, resolved when read (callers pass a getter for locale changes). */
	label: string;
	/** `Date.now()` when the run started. */
	startedAt: number;
}

/**
 * - `saved`: every write in the episode landed.
 * - `failed`: at least one did not; its own error toast says so.
 * - `unconfirmed`: they landed, but another queue still holds work it has not
 *   sent (Postbox's offline outbox), so "all saved" would not be true.
 * - `discarded`: the registry was reset for an identity change; whatever was
 *   waiting belongs to the previous session and is not reported.
 */
export type SlowEpisodeOutcome = 'saved' | 'failed' | 'unconfirmed' | 'discarded';

interface Entry {
	id: number;
	/** `null` for a hold: it keeps an episode open but is never listed or slow. */
	label: (() => string) | null;
	/** Wall clock, for the Details list ("waiting since"). */
	startedAt: number;
	/** `performance.now()` when it turns slow: monotonic, so a clock change cannot move it. */
	dueAt: number;
	slow: boolean;
}

const entries = new Map<number, Entry>();
/** Labelled runs that have not crossed the threshold yet, in start order. */
const waiting = new Set<Entry>();
let slowTimer: ReturnType<typeof setTimeout> | undefined;
let quietTimer: ReturnType<typeof setTimeout> | undefined;
let nextId = 1;
let episode: { failed: boolean } | null = null;
const episodeListeners = new Set<(outcome: SlowEpisodeOutcome) => void>();
const unsavedWorkProbes = new Set<() => boolean>();

const slowCount = shallowRef(0);
/** Bumped on every change to the slow set, so the lazy list below recomputes. */
const slowVersion = shallowRef(0);

/** How many runs have been pending longer than {@link SLOW_OPERATION_MS}. */
export const slowOperationCount = computed(() => slowCount.value);

/**
 * The runs pending longer than {@link SLOW_OPERATION_MS}, oldest first. Lazy:
 * built (and the labels resolved) only when something reads it, at most once
 * per change, however many runs crossed the threshold together.
 */
export const slowOperations = computed<readonly SlowOperation[]>(() => {
	void slowVersion.value;
	const list: SlowOperation[] = [];
	for (const entry of entries.values()) {
		if (entry.slow && entry.label) {
			list.push({ id: entry.id, label: entry.label(), startedAt: entry.startedAt });
		}
	}
	return list;
});

function emit(outcome: SlowEpisodeOutcome): void {
	for (const listener of episodeListeners) listener(outcome);
}

/** Arm the one threshold timer for the oldest run still under it, if none is armed. */
function scheduleSlowTimer(): void {
	if (slowTimer !== undefined) return;
	const head = waiting.values().next();
	if (head.done) return;
	const delay = Math.max(0, head.value.dueAt - performance.now());
	slowTimer = setTimeout(markDueRuns, delay);
}

/** Mark every run that has crossed the threshold, then publish once. */
function markDueRuns(): void {
	slowTimer = undefined;
	const now = performance.now();
	let marked = 0;
	for (const entry of waiting) {
		if (entry.dueAt > now) break;
		waiting.delete(entry);
		entry.slow = true;
		marked += 1;
	}
	if (marked > 0) {
		episode ??= { failed: false };
		slowCount.value += marked;
		slowVersion.value += 1;
	}
	scheduleSlowTimer();
}

function endEpisodeWhenQuiet(): void {
	if (!episode || entries.size > 0 || quietTimer !== undefined) return;
	quietTimer = setTimeout(() => {
		quietTimer = undefined;
		if (!episode || entries.size > 0) return;
		const { failed } = episode;
		episode = null;
		let outcome: SlowEpisodeOutcome = failed ? 'failed' : 'saved';
		if (outcome === 'saved' && [...unsavedWorkProbes].some((probe) => probe())) {
			outcome = 'unconfirmed';
		}
		emit(outcome);
	}, EPISODE_QUIET_MS);
}

function register(label: (() => string) | null): (ok: boolean) => void {
	const entry: Entry = {
		id: nextId++,
		label,
		startedAt: Date.now(),
		dueAt: performance.now() + SLOW_OPERATION_MS,
		slow: false,
	};
	entries.set(entry.id, entry);
	// The next step of a save arrived in time: the episode goes on.
	clearTimeout(quietTimer);
	quietTimer = undefined;
	if (label) {
		waiting.add(entry);
		scheduleSlowTimer();
	}
	return (ok: boolean) => {
		if (entries.get(entry.id) !== entry) return;
		entries.delete(entry.id);
		if (waiting.delete(entry) && waiting.size === 0) {
			// Nothing left to cross the threshold: no reason to wake up.
			clearTimeout(slowTimer);
			slowTimer = undefined;
		}
		if (!ok && episode) episode.failed = true;
		if (entry.slow) {
			slowCount.value -= 1;
			slowVersion.value += 1;
		}
		endEpisodeWhenQuiet();
	};
}

/**
 * Register one run. Returns its settle: call it once with whether the write
 * succeeded. Settling a run the registry already forgot (see
 * {@link resetPendingOperations}) does nothing.
 */
export function trackPendingOperation(label: () => string): (ok: boolean) => void {
	return register(label);
}

/**
 * Keep the current slow episode open while work the registry cannot see is
 * under way: a file transfer, or the steps of a save that runs several calls in
 * a row. A hold never makes anything slow and is never listed; it only stops
 * "all changes saved" from being claimed before that work is done, and a hold
 * released with `false` ends the episode as failed. Returns the release, which
 * works like a run's settle.
 */
export function holdPendingWork(): (ok: boolean) => void {
	return register(null);
}

/**
 * Run `work` under a hold: released as succeeded when it resolves, as failed
 * when it throws. For flows that report failure by throwing.
 */
export async function withPendingHold<T>(work: () => Promise<T>): Promise<T> {
	const release = holdPendingWork();
	let ok = false;
	try {
		const result = await work();
		ok = true;
		return result;
	} finally {
		release(ok);
	}
}

/** Hear how each slow episode ended. Returns the unsubscribe. */
export function onSlowEpisodeEnd(listener: (outcome: SlowEpisodeOutcome) => void): () => void {
	episodeListeners.add(listener);
	return () => episodeListeners.delete(listener);
}

/**
 * Let a queue that bypasses `useBackendOperation` veto "all changes saved"
 * while it still holds work: `probe` answers whether it does. Returns the
 * unregister.
 */
export function registerUnsavedWorkProbe(probe: () => boolean): () => void {
	unsavedWorkProbes.add(probe);
	return () => unsavedWorkProbes.delete(probe);
}

/**
 * Forget every pending run and hold. For an identity change: the previous
 * session's writes must not produce a notice in the next one. Listeners hear
 * `discarded`, so whatever they kept for the old session (a dismissed warning,
 * an open Details list) goes too.
 */
export function resetPendingOperations(): void {
	clearTimeout(slowTimer);
	clearTimeout(quietTimer);
	slowTimer = undefined;
	quietTimer = undefined;
	entries.clear();
	waiting.clear();
	episode = null;
	slowCount.value = 0;
	slowVersion.value += 1;
	emit('discarded');
}
