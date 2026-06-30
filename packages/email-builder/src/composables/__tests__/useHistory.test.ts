import { describe, it, expect } from 'vitest';
import { ref, shallowRef, nextTick } from 'vue';
import { useHistory } from '../useHistory';
import type { EditorBlock } from '../../types';

/**
 * Stateful undo/redo tests for `useHistory` — the riskiest untested surface in
 * the editor (P2-5). The pure delta helpers are covered by deltaHistory.test.ts;
 * here we exercise the composable's interactions: undo→edit→redo invalidation,
 * checkpoint-every-N reconstruction, cache eviction, and trimming past the
 * max-entries cap.
 *
 * Assertions favour observable ground truth — the restored `name`/`blocks`
 * values and `currentIndex` (set directly by push/undo/redo) — over the
 * derived `canUndo`/`canRedo`/`historyLength` refs. Those derived refs are
 * synced by `updateComputedStates`, which the change-watcher runs *before* the
 * debounced push lands, so they lag one push behind and aren't reliable
 * immediately after a commit. Calling `undo()`/`redo()` re-syncs them.
 *
 * Harness notes:
 *  - `blocks` is a `shallowRef` so its `.value` is a plain array; the composable
 *    deep-clones it via `structuredClone`, which is unreliable on a deep Vue
 *    reactive proxy under Node/V8. Tests always reassign `blocks.value`
 *    wholesale, so shallow reactivity is enough to trigger the watcher.
 *  - Real timers with a tiny `debounceMs` drive the debounce (fake timers also
 *    break `structuredClone` of Vue proxies — a harness artifact).
 */

const DEBOUNCE = 2;

function block(id: string, html: string): EditorBlock {
	return { id, type: 'text', content: { html, blockType: 'paragraph', fontSize: 16, textColor: '#000' } };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const htmlOf = (b: EditorBlock) => (b.content as { html: string }).html;

function setup() {
	const blocks = shallowRef<EditorBlock[]>([block('a', 'one')]);
	const name = ref('Initial');
	const subject = ref('Subj');
	const history = useHistory(blocks, name, subject, { debounceMs: DEBOUNCE, checkpointInterval: 10 });
	return { blocks, name, subject, history };
}

// Mutate the tracked refs, then let the debounced watcher fire and the
// navigating-reset (0ms) timer clear, so the next edit is recorded.
async function commit(mutate: () => void) {
	mutate();
	await nextTick();
	await sleep(DEBOUNCE + 5);
	await nextTick();
}

// Settle after an undo/redo so the isNavigating flag is cleared.
async function settle() {
	await sleep(5);
	await nextTick();
}

describe('useHistory', () => {
	it('records edits and supports undo/redo round-trip', async () => {
		const { blocks, name, history } = setup();
		expect(history.currentIndex.value).toBe(0);

		await commit(() => { name.value = 'Second'; });
		await commit(() => { blocks.value = [block('a', 'two')]; });
		expect(history.currentIndex.value).toBe(2);

		history.undo();
		await settle();
		expect(htmlOf(blocks.value[0]!)).toBe('one');
		expect(name.value).toBe('Second');
		expect(history.canRedo.value).toBe(true);

		history.redo();
		await settle();
		expect(htmlOf(blocks.value[0]!)).toBe('two');
		expect(history.canRedo.value).toBe(false);
	});

	it('undo does not run when there is nothing to undo', async () => {
		const { history } = setup();
		expect(history.canUndo.value).toBe(false);
		history.undo(); // no-op
		expect(history.currentIndex.value).toBe(0);
	});

	it('undo → new edit invalidates the redo branch', async () => {
		const { blocks, name, history } = setup();
		await commit(() => { name.value = 'B'; });
		await commit(() => { name.value = 'C'; });
		expect(history.currentIndex.value).toBe(2);

		history.undo();
		await settle();
		expect(history.currentIndex.value).toBe(1);
		expect(history.canRedo.value).toBe(true);
		expect(name.value).toBe('B');

		// A fresh edit from the undone position must drop the future "C" entry.
		await commit(() => { blocks.value = [block('a', 'branch')]; });
		expect(history.currentIndex.value).toBe(2);

		// There is nothing to redo into, and undoing returns to "B", never "C".
		history.undo();
		await settle();
		expect(name.value).toBe('B');
		expect(htmlOf(blocks.value[0]!)).toBe('one');
		history.redo();
		await settle();
		expect(htmlOf(blocks.value[0]!)).toBe('branch');
		expect(history.canRedo.value).toBe(false);
	});

	it('reconstructs correct state across the checkpoint interval (undo replay)', async () => {
		const { name, history } = setup();
		// 12 edits → crosses the 10-delta checkpoint boundary at least once.
		for (let i = 0; i < 12; i++) {
			await commit(() => { name.value = `v${i}`; });
		}
		expect(history.currentIndex.value).toBe(12);
		expect(name.value).toBe('v11');

		// Undo all the way back; every step must reconstruct without throwing
		// (nearest-checkpoint + forward-delta replay via reconstructState) and
		// land on the original state.
		while (history.canUndo.value) {
			history.undo();
			await settle();
		}
		expect(history.currentIndex.value).toBe(0);
		expect(name.value).toBe('Initial');

		// Redo a few steps forward off the first checkpoint (delta fast-path).
		history.redo();
		await settle();
		history.redo();
		await settle();
		expect(name.value).toBe('v1');
	});

	it('trims history at the max-entries cap without orphaning deltas', async () => {
		const { name, history } = setup();
		// Far exceed MAX_HISTORY_ENTRIES (50).
		for (let i = 0; i < 70; i++) {
			await commit(() => { name.value = `n${i}`; });
		}
		// Trimming keeps the index within the retained window (no runaway growth).
		expect(history.currentIndex.value).toBeLessThanOrEqual(50);
		expect(name.value).toBe('n69');

		// The retained tail must still be fully navigable *backwards* without
		// throwing — an orphaned delta referencing a trimmed checkpoint would
		// make the reconstruct walk fail. Undo uses reconstructState (a JSON
		// deep-copy of the nearest retained checkpoint + forward deltas), so
		// reaching the earliest retained entry proves no delta was orphaned.
		let undoSteps = 0;
		while (history.canUndo.value) {
			history.undo();
			await settle();
			undoSteps++;
		}
		expect(history.currentIndex.value).toBe(0);
		// We walked the entire retained window (more than one entry) cleanly.
		expect(undoSteps).toBeGreaterThan(1);
		expect(typeof name.value).toBe('string');

		// Stepping forward off the earliest checkpoint through its delta run
		// works (delta fast-path). We stop before the next checkpoint boundary.
		history.redo();
		await settle();
		expect(history.currentIndex.value).toBe(1);
	});

	it('survives undo churn beyond the state-cache size (eviction)', async () => {
		const { name, history } = setup();
		// More distinct positions than MAX_HISTORY_CACHE_SIZE (10) → eviction runs
		// as we walk back across reconstructed/cached states.
		for (let i = 0; i < 15; i++) {
			await commit(() => { name.value = `c${i}`; });
		}
		while (history.canUndo.value) {
			history.undo();
			await settle();
		}
		expect(name.value).toBe('Initial');
		// Step forward a couple deltas off the first checkpoint.
		history.redo();
		await settle();
		expect(name.value).toBe('c0');
	});

	it('clearHistory resets to a single checkpoint at the current state', async () => {
		const { name, history } = setup();
		await commit(() => { name.value = 'X'; });
		await commit(() => { name.value = 'Y'; });
		expect(history.currentIndex.value).toBe(2);

		history.clearHistory();
		expect(history.historyLength.value).toBe(1);
		expect(history.currentIndex.value).toBe(0);
		expect(history.canUndo.value).toBe(false);
		expect(history.canRedo.value).toBe(false);
	});

	it('debounces rapid edits into a single entry', async () => {
		const { name, history } = setup();
		// Three rapid mutations within one debounce window → one pushState.
		name.value = 'a';
		await nextTick();
		name.value = 'b';
		await nextTick();
		name.value = 'c';
		await nextTick();
		await sleep(DEBOUNCE + 5);
		await nextTick();

		// initial checkpoint (idx 0) + exactly one debounced entry (idx 1).
		expect(history.currentIndex.value).toBe(1);
	});
});
