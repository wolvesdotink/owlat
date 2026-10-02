import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { effectScope, ref, nextTick, type EffectScope } from 'vue';
import { useHistory } from '../useHistory';
import type { EditorBlock } from '../../types';

/**
 * Stateful undo/redo tests for `useHistory` — the riskiest untested surface in
 * the editor (P2-5). The pure delta helpers are covered by deltaHistory.test.ts;
 * here we exercise the composable's interactions: undo→edit→redo invalidation,
 * checkpoint-every-N reconstruction, cache eviction, trimming past the
 * max-entries cap, and the availability flags the toolbar and shortcuts read.
 *
 * `canUndo`/`canRedo`/`historyLength` are part of the contract: the Undo and
 * Redo buttons render from them, so every test that moves through history
 * asserts them alongside the restored values and `currentIndex`.
 *
 * Harness notes:
 *  - `blocks` is a deep `ref`, matching the editor's `canvasBlocks`. Its
 *    `.value` is a reactive proxy, which `structuredClone` rejects in every
 *    engine (DataCloneError) — the composable's clone (utils/plainClone) must
 *    read through it, so using a deep ref here is the regression test for the
 *    editor crashing at mount.
 *  - The composable runs inside an effect scope, as it does in the editor, and
 *    fake timers drive the debounce so pending-edit interleavings are exact.
 */

const DEBOUNCE = 2;

function block(id: string, html: string): EditorBlock {
	return {
		id,
		type: 'text',
		content: { html, blockType: 'paragraph', fontSize: 16, textColor: '#000' },
	};
}

const htmlOf = (b: EditorBlock) => (b.content as { html: string }).html;

let scope: EffectScope | null = null;

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	scope?.stop();
	scope = null;
	vi.useRealTimers();
});

function setup() {
	const blocks = ref<EditorBlock[]>([block('a', 'one')]);
	const name = ref('Initial');
	const subject = ref('Subj');
	scope = effectScope();
	const history = scope.run(() =>
		useHistory(blocks, name, subject, {
			debounceMs: DEBOUNCE,
			checkpointInterval: 10,
		})
	)!;
	return { blocks, name, subject, history };
}

// Mutate the tracked refs and let the watcher see it; the edit is now pending.
async function edit(mutate: () => void) {
	mutate();
	await nextTick();
}

// Mutate the tracked refs, then let the debounced push fire, so the edit is
// committed and the next one is recorded separately.
async function commit(mutate: () => void) {
	await edit(mutate);
	vi.advanceTimersByTime(DEBOUNCE);
	await nextTick();
}

// Settle after an undo/redo: the watcher sees the applied state, then the
// navigating-reset (0ms) timer clears so the next edit is recorded.
async function settle() {
	await nextTick();
	vi.advanceTimersByTime(0);
	await nextTick();
}

// The flags the toolbar renders, read together.
function flags(history: ReturnType<typeof setup>['history']) {
	return {
		canUndo: history.canUndo.value,
		canRedo: history.canRedo.value,
		length: history.historyLength.value,
		index: history.currentIndex.value,
	};
}

describe('useHistory', () => {
	it('records edits and supports undo/redo round-trip', async () => {
		const { blocks, name, history } = setup();
		expect(flags(history)).toEqual({ canUndo: false, canRedo: false, length: 1, index: 0 });

		await commit(() => {
			name.value = 'Second';
		});
		await commit(() => {
			blocks.value = [block('a', 'two')];
		});
		expect(flags(history)).toEqual({ canUndo: true, canRedo: false, length: 3, index: 2 });

		history.undo();
		await settle();
		expect(htmlOf(blocks.value[0]!)).toBe('one');
		expect(name.value).toBe('Second');
		expect(flags(history)).toEqual({ canUndo: true, canRedo: true, length: 3, index: 1 });

		history.redo();
		await settle();
		expect(htmlOf(blocks.value[0]!)).toBe('two');
		expect(flags(history)).toEqual({ canUndo: true, canRedo: false, length: 3, index: 2 });
	});

	it('offers Undo as soon as the first edit is committed, and it restores the initial state', async () => {
		const { blocks, name, history } = setup();

		await commit(() => {
			name.value = 'B';
		});
		expect(flags(history)).toEqual({ canUndo: true, canRedo: false, length: 2, index: 1 });

		history.undo();
		await settle();
		expect(name.value).toBe('Initial');
		expect(htmlOf(blocks.value[0]!)).toBe('one');
		expect(flags(history)).toEqual({ canUndo: false, canRedo: true, length: 2, index: 0 });
	});

	it('undo does not run when there is nothing to undo', async () => {
		const { name, history } = setup();
		expect(history.canUndo.value).toBe(false);
		history.undo(); // no-op
		await settle();
		expect(history.currentIndex.value).toBe(0);
		expect(name.value).toBe('Initial');
	});

	it('redo does not move past the last entry when called directly', async () => {
		const { name, history } = setup();
		await commit(() => {
			name.value = 'B';
		});
		expect(history.canRedo.value).toBe(false);

		history.redo();
		history.redo();
		await settle();
		expect(flags(history)).toEqual({ canUndo: true, canRedo: false, length: 2, index: 1 });
		expect(name.value).toBe('B');
	});

	it('undo → new edit invalidates the redo branch', async () => {
		const { blocks, name, history } = setup();
		await commit(() => {
			name.value = 'B';
		});
		await commit(() => {
			name.value = 'C';
		});
		expect(history.currentIndex.value).toBe(2);

		history.undo();
		await settle();
		expect(flags(history)).toEqual({ canUndo: true, canRedo: true, length: 3, index: 1 });
		expect(name.value).toBe('B');

		// A fresh edit from the undone position must drop the future "C" entry.
		await commit(() => {
			blocks.value = [block('a', 'branch')];
		});
		expect(flags(history)).toEqual({ canUndo: true, canRedo: false, length: 3, index: 2 });

		// A direct redo call has nothing to move into: it stays in bounds and
		// leaves the branch on screen.
		history.redo();
		await settle();
		expect(flags(history)).toEqual({ canUndo: true, canRedo: false, length: 3, index: 2 });
		expect(htmlOf(blocks.value[0]!)).toBe('branch');
		expect(name.value).toBe('B');

		// Undoing returns to "B", never "C".
		history.undo();
		await settle();
		expect(name.value).toBe('B');
		expect(htmlOf(blocks.value[0]!)).toBe('one');
		history.redo();
		await settle();
		expect(htmlOf(blocks.value[0]!)).toBe('branch');
		expect(flags(history)).toEqual({ canUndo: true, canRedo: false, length: 3, index: 2 });
	});

	it('reconstructs correct state across the checkpoint interval (undo replay)', async () => {
		const { name, history } = setup();
		// 12 edits → crosses the 10-delta checkpoint boundary at least once.
		for (let i = 0; i < 12; i++) {
			await commit(() => {
				name.value = `v${i}`;
			});
		}
		expect(flags(history)).toEqual({ canUndo: true, canRedo: false, length: 13, index: 12 });
		expect(name.value).toBe('v11');

		// Undo all the way back; every step must reconstruct without throwing
		// (nearest-checkpoint + forward-delta replay via reconstructState) and
		// land on the original state.
		let undoSteps = 0;
		while (history.canUndo.value) {
			history.undo();
			await settle();
			undoSteps++;
		}
		expect(undoSteps).toBe(12);
		expect(flags(history)).toEqual({ canUndo: false, canRedo: true, length: 13, index: 0 });
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
			await commit(() => {
				name.value = `n${i}`;
			});
		}
		// Trimming keeps the index within the retained window (no runaway growth),
		// and the flags describe that window.
		expect(history.historyLength.value).toBeLessThanOrEqual(50);
		expect(history.currentIndex.value).toBe(history.historyLength.value - 1);
		expect(history.canUndo.value).toBe(true);
		expect(history.canRedo.value).toBe(false);
		expect(name.value).toBe('n69');

		// The retained tail must still be fully navigable *backwards* without
		// throwing — an orphaned delta referencing a trimmed checkpoint would
		// make the reconstruct walk fail. Undo uses reconstructState (a JSON
		// deep-copy of the nearest retained checkpoint + forward deltas), so
		// reaching the earliest retained entry proves no delta was orphaned.
		const retained = history.historyLength.value;
		let undoSteps = 0;
		while (history.canUndo.value) {
			history.undo();
			await settle();
			undoSteps++;
		}
		expect(history.currentIndex.value).toBe(0);
		// We walked the entire retained window (more than one entry) cleanly.
		expect(undoSteps).toBe(retained - 1);
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
			await commit(() => {
				name.value = `c${i}`;
			});
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
		await commit(() => {
			name.value = 'X';
		});
		await commit(() => {
			name.value = 'Y';
		});
		expect(history.currentIndex.value).toBe(2);

		history.clearHistory();
		expect(flags(history)).toEqual({ canUndo: false, canRedo: false, length: 1, index: 0 });
		expect(name.value).toBe('Y');
	});

	it('debounces rapid edits into a single entry', async () => {
		const { name, history } = setup();
		// Three rapid mutations within one debounce window → one pushState.
		await edit(() => {
			name.value = 'a';
		});
		await edit(() => {
			name.value = 'b';
		});
		await edit(() => {
			name.value = 'c';
		});
		vi.advanceTimersByTime(DEBOUNCE);
		await nextTick();

		// initial checkpoint (idx 0) + exactly one debounced entry (idx 1).
		expect(flags(history)).toEqual({ canUndo: true, canRedo: false, length: 2, index: 1 });
	});

	describe('an edit still inside the debounce window', () => {
		it('offers Undo and withholds Redo until it commits', async () => {
			const { name, history } = setup();
			await commit(() => {
				name.value = 'B';
			});
			history.undo();
			await settle();
			expect(history.canRedo.value).toBe(true);

			await edit(() => {
				name.value = 'D';
			});
			// Committing "D" will drop the redo branch, so Redo is already gone;
			// Undo is offered for "D" itself. Nothing is committed yet.
			expect(flags(history)).toEqual({ canUndo: true, canRedo: false, length: 2, index: 0 });

			vi.advanceTimersByTime(DEBOUNCE);
			await nextTick();
			expect(flags(history)).toEqual({ canUndo: true, canRedo: false, length: 2, index: 1 });
		});

		it('is committed and then undone by undo, and its timer does not push it back', async () => {
			const { name, history } = setup();
			await commit(() => {
				name.value = 'B';
			});
			await edit(() => {
				name.value = 'C';
			});

			history.undo();
			await settle();
			expect(name.value).toBe('B');
			expect(flags(history)).toEqual({ canUndo: true, canRedo: true, length: 3, index: 1 });

			// The debounce window the edit opened passes: nothing lands on top.
			vi.advanceTimersByTime(DEBOUNCE * 10);
			await nextTick();
			expect(name.value).toBe('B');
			expect(flags(history)).toEqual({ canUndo: true, canRedo: true, length: 3, index: 1 });

			history.redo();
			await settle();
			expect(name.value).toBe('C');
		});

		it('undoes the very first edit before it has committed', async () => {
			const { name, history } = setup();
			await edit(() => {
				name.value = 'B';
			});
			expect(history.canUndo.value).toBe(true);

			history.undo();
			await settle();
			vi.advanceTimersByTime(DEBOUNCE * 10);
			await nextTick();
			expect(name.value).toBe('Initial');
			expect(flags(history)).toEqual({ canUndo: false, canRedo: true, length: 2, index: 0 });
		});

		it('is committed, dropping the redo branch, when redo is called', async () => {
			const { name, history } = setup();
			await commit(() => {
				name.value = 'B';
			});
			await commit(() => {
				name.value = 'C';
			});
			history.undo();
			await settle();
			await edit(() => {
				name.value = 'D';
			});

			history.redo();
			await settle();
			expect(name.value).toBe('D');
			expect(flags(history)).toEqual({ canUndo: true, canRedo: false, length: 3, index: 2 });

			history.undo();
			await settle();
			expect(name.value).toBe('B');
		});

		it('is folded into the reset by clearHistory, and its timer does not push later', async () => {
			const { name, history } = setup();
			await commit(() => {
				name.value = 'B';
			});
			await edit(() => {
				name.value = 'C';
			});

			history.clearHistory();
			expect(flags(history)).toEqual({ canUndo: false, canRedo: false, length: 1, index: 0 });

			vi.advanceTimersByTime(DEBOUNCE * 10);
			await nextTick();
			expect(flags(history)).toEqual({ canUndo: false, canRedo: false, length: 1, index: 0 });
			expect(name.value).toBe('C');
		});

		it('becomes its own step when commitPending runs before a state load', async () => {
			const { name, subject, history } = setup();
			await edit(() => {
				name.value = 'Typed';
			});

			// What EmailBuilder.loadState does: commit the pending edit, then
			// replace the state.
			history.commitPending();
			expect(flags(history)).toEqual({ canUndo: true, canRedo: false, length: 2, index: 1 });
			await commit(() => {
				name.value = 'Loaded';
				subject.value = 'Loaded subject';
			});
			expect(flags(history)).toEqual({ canUndo: true, canRedo: false, length: 3, index: 2 });

			history.undo();
			await settle();
			expect(name.value).toBe('Typed');
			expect(subject.value).toBe('Subj');
			history.undo();
			await settle();
			expect(name.value).toBe('Initial');
			expect(history.canUndo.value).toBe(false);
		});

		it('is dropped with its timer when the owning scope is disposed', async () => {
			const { name, history } = setup();
			await edit(() => {
				name.value = 'B';
			});
			expect(vi.getTimerCount()).toBeGreaterThan(0);

			scope!.stop();
			expect(vi.getTimerCount()).toBe(0);
			vi.advanceTimersByTime(DEBOUNCE * 10);
			expect(history.historyLength.value).toBe(1);
		});
	});

	describe("absorb (a collaborator's change)", () => {
		// Their change: block `b` appears after `a`, and the subject changes.
		const theirs = (state: { blocks: EditorBlock[]; name: string; subject: string }) => ({
			...state,
			blocks: [...state.blocks, block('b', 'theirs')],
			subject: 'Their subject',
		});

		async function receive(ctx: ReturnType<typeof setup>, transform: typeof theirs): Promise<void> {
			ctx.history.absorb(transform);
			const next = transform({
				blocks: ctx.blocks.value,
				name: ctx.name.value,
				subject: ctx.subject.value,
			});
			ctx.blocks.value = next.blocks;
			ctx.subject.value = next.subject;
			await settle();
		}

		it('is not recorded as an undo step', async () => {
			const ctx = setup();
			await commit(() => {
				ctx.name.value = 'Mine';
			});
			await receive(ctx, theirs);
			expect(flags(ctx.history)).toEqual({ canUndo: true, canRedo: false, length: 2, index: 1 });
		});

		it("undoes only this editor's own edits and keeps theirs", async () => {
			const ctx = setup();
			await commit(() => {
				ctx.blocks.value = [block('a', 'mine')];
			});
			await receive(ctx, theirs);

			ctx.history.undo();
			await settle();
			expect(ctx.blocks.value.map(htmlOf)).toEqual(['one', 'theirs']);
			expect(ctx.subject.value).toBe('Their subject');

			ctx.history.redo();
			await settle();
			expect(ctx.blocks.value.map(htmlOf)).toEqual(['mine', 'theirs']);
			expect(ctx.subject.value).toBe('Their subject');
		});

		it('commits a pending edit first so it stays its own step', async () => {
			const ctx = setup();
			await edit(() => {
				ctx.name.value = 'Typing';
			});
			await receive(ctx, theirs);
			expect(ctx.history.historyLength.value).toBe(2);

			ctx.history.undo();
			await settle();
			expect(ctx.name.value).toBe('Initial');
			expect(ctx.blocks.value.map(htmlOf)).toEqual(['one', 'theirs']);
		});

		it('records the next own edit as a delta on top of the absorbed state', async () => {
			const ctx = setup();
			await receive(ctx, theirs);
			await commit(() => {
				ctx.name.value = 'After';
			});
			ctx.history.undo();
			await settle();
			expect(ctx.name.value).toBe('Initial');
			expect(ctx.blocks.value.map(htmlOf)).toEqual(['one', 'theirs']);
		});
	});
});
