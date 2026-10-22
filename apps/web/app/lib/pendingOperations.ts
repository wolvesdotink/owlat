/**
 * The writes that are still waiting for the server, app-wide.
 *
 * `useBackendOperation` registers every mutation run here and settles it when
 * the call returns. A run still unanswered after {@link SLOW_OPERATION_MS} is
 * listed in {@link slowOperations}, which the shell turns into one "saving is
 * taking longer than usual" notice. Runs are tracked by their own id, not by an
 * operation's loading flag, so overlapping runs of the same operation settle
 * independently.
 *
 * A slow episode starts when the first run turns slow and ends when nothing at
 * all is pending. Its outcome is `saved` only if every run settled in that time
 * succeeded and no other queue still holds unsaved work; a failure has its own
 * error surface already, so the episode then ends without a success message.
 */
import { readonly, shallowRef } from 'vue';

/** How long a write may take before the shell says it is slow. */
export const SLOW_OPERATION_MS = 5_000;

export interface SlowOperation {
	id: number;
	/** The operation's label, resolved now (callers pass a getter for locale changes). */
	label: string;
	/** `Date.now()` when the run started. */
	startedAt: number;
}

/**
 * - `saved`: every write in the episode landed.
 * - `failed`: at least one did not; its own error toast says so.
 * - `unconfirmed`: they landed, but another queue still holds work it has not
 *   sent (Postbox's offline outbox), so "all saved" would not be true.
 */
export type SlowEpisodeOutcome = 'saved' | 'failed' | 'unconfirmed';

interface Entry {
	id: number;
	label: () => string;
	startedAt: number;
	slow: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
}

const entries = new Map<number, Entry>();
let nextId = 1;
let episode: { failed: boolean } | null = null;
const episodeListeners = new Set<(outcome: SlowEpisodeOutcome) => void>();
const unsavedWorkProbes = new Set<() => boolean>();

const slow = shallowRef<readonly SlowOperation[]>([]);

/** The runs pending longer than {@link SLOW_OPERATION_MS}, oldest first. */
export const slowOperations = readonly(slow);

function publish(): void {
	const next: SlowOperation[] = [];
	for (const entry of entries.values()) {
		if (entry.slow) next.push({ id: entry.id, label: entry.label(), startedAt: entry.startedAt });
	}
	if (next.length === 0 && slow.value.length === 0) return;
	slow.value = next;
}

function endEpisodeIfIdle(): void {
	if (!episode || entries.size > 0) return;
	const { failed } = episode;
	episode = null;
	let outcome: SlowEpisodeOutcome = failed ? 'failed' : 'saved';
	if (outcome === 'saved' && [...unsavedWorkProbes].some((probe) => probe())) {
		outcome = 'unconfirmed';
	}
	for (const listener of episodeListeners) listener(outcome);
}

/**
 * Register one run. Returns its settle: call it once with whether the write
 * succeeded. Settling a run the registry already forgot (see
 * {@link resetPendingOperations}) does nothing.
 */
export function trackPendingOperation(label: () => string): (ok: boolean) => void {
	const id = nextId++;
	const entry: Entry = { id, label, startedAt: Date.now(), slow: false, timer: undefined };
	entry.timer = setTimeout(() => {
		entry.timer = undefined;
		if (entries.get(id) !== entry) return;
		entry.slow = true;
		episode ??= { failed: false };
		publish();
	}, SLOW_OPERATION_MS);
	entries.set(id, entry);
	return (ok: boolean) => {
		if (entries.get(id) !== entry) return;
		clearTimeout(entry.timer);
		entries.delete(id);
		if (!ok && episode) episode.failed = true;
		if (entry.slow) publish();
		endEpisodeIfIdle();
	};
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
 * Forget every pending run without an outcome. For an identity change: the
 * previous session's writes must not produce a notice in the next one.
 */
export function resetPendingOperations(): void {
	for (const entry of entries.values()) clearTimeout(entry.timer);
	entries.clear();
	episode = null;
	if (slow.value.length > 0) slow.value = [];
}
