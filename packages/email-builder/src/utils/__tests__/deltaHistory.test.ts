import { describe, it, expect } from 'vitest';
import {
	generatePatches,
	applyPatches,
	shouldCreateCheckpoint,
	reconstructState,
	type HistoryCheckpoint,
	type HistoryEntry,
} from '../deltaHistory';
import type { HistoryState } from '../../composables/useHistory';
import type { EditorBlock } from '../../types';

const makeState = (overrides: Partial<HistoryState> = {}): HistoryState => ({
	blocks: [],
	name: 'Test Email',
	subject: 'Test Subject',
	...overrides,
});

describe('generatePatches', () => {
	it('generates empty patches for identical states', () => {
		const state = makeState();
		const { patches, reversePatches } = generatePatches(state, state);
		expect(patches).toHaveLength(0);
		expect(reversePatches).toHaveLength(0);
	});

	it('generates forward patches for name change', () => {
		const old = makeState({ name: 'Old' });
		const next = makeState({ name: 'New' });
		const { patches, reversePatches } = generatePatches(old, next);
		expect(patches.length).toBeGreaterThan(0);
		expect(reversePatches.length).toBeGreaterThan(0);
	});

	it('generates forward patches for block addition', () => {
		const old = makeState({ blocks: [] });
		const next = makeState({
			blocks: [{ id: 'b1', type: 'text', content: { html: 'Hi' } } as unknown as EditorBlock],
		});
		const { patches } = generatePatches(old, next);
		expect(patches.length).toBeGreaterThan(0);
		// Should have an add operation
		expect(patches.some((p) => p.op === 'add' || p.op === 'replace')).toBe(true);
	});

	it('generates reverse patches that undo the change', () => {
		const old = makeState({ name: 'Old' });
		const next = makeState({ name: 'New' });
		const { patches, reversePatches } = generatePatches(old, next);

		// Applying reverse to "next" should get back to "old"
		const restored = applyPatches(next, reversePatches);
		expect(restored.name).toBe('Old');

		// Applying forward to "old" should get to "next"
		const applied = applyPatches(old, patches);
		expect(applied.name).toBe('New');
	});
});

describe('applyPatches', () => {
	it('applies forward patches correctly', () => {
		const old = makeState({ subject: 'Old Subject' });
		const next = makeState({ subject: 'New Subject' });
		const { patches } = generatePatches(old, next);

		const result = applyPatches(old, patches);
		expect(result.subject).toBe('New Subject');
	});

	it('applies reverse patches correctly', () => {
		const old = makeState({ subject: 'Old Subject' });
		const next = makeState({ subject: 'New Subject' });
		const { reversePatches } = generatePatches(old, next);

		const result = applyPatches(next, reversePatches);
		expect(result.subject).toBe('Old Subject');
	});

	it('does not mutate the original state', () => {
		const old = makeState({ name: 'Original' });
		const next = makeState({ name: 'Changed' });
		const { patches } = generatePatches(old, next);

		applyPatches(old, patches);
		expect(old.name).toBe('Original'); // unchanged
	});

	it('handles empty patches array', () => {
		const state = makeState();
		const result = applyPatches(state, []);
		expect(result.name).toBe(state.name);
		expect(result.subject).toBe(state.subject);
	});
});

describe('shouldCreateCheckpoint', () => {
	it('returns true for empty entries', () => {
		expect(shouldCreateCheckpoint([], 0, 5)).toBe(true);
	});

	it('returns false when delta count is below interval', () => {
		const entries: HistoryEntry[] = [
			{ type: 'checkpoint', state: makeState() },
			{ type: 'delta', patches: [], reversePatches: [] },
			{ type: 'delta', patches: [], reversePatches: [] },
		];
		expect(shouldCreateCheckpoint(entries, 2, 5)).toBe(false);
	});

	it('returns true when delta count reaches interval', () => {
		const entries: HistoryEntry[] = [
			{ type: 'checkpoint', state: makeState() },
			{ type: 'delta', patches: [], reversePatches: [] },
			{ type: 'delta', patches: [], reversePatches: [] },
			{ type: 'delta', patches: [], reversePatches: [] },
			{ type: 'delta', patches: [], reversePatches: [] },
			{ type: 'delta', patches: [], reversePatches: [] },
		];
		expect(shouldCreateCheckpoint(entries, 5, 5)).toBe(true);
	});

	it('counts deltas from the nearest checkpoint', () => {
		const entries: HistoryEntry[] = [
			{ type: 'checkpoint', state: makeState() },
			{ type: 'delta', patches: [], reversePatches: [] },
			{ type: 'delta', patches: [], reversePatches: [] },
			{ type: 'checkpoint', state: makeState() }, // reset count
			{ type: 'delta', patches: [], reversePatches: [] },
		];
		// At index 4, only 1 delta since last checkpoint at index 3
		expect(shouldCreateCheckpoint(entries, 4, 3)).toBe(false);
	});
});

describe('reconstructState', () => {
	it('returns checkpoint state when target is a checkpoint', () => {
		const state = makeState({ name: 'Checkpoint' });
		const entries: HistoryEntry[] = [{ type: 'checkpoint', state }];
		const result = reconstructState(entries, 0);
		expect(result.name).toBe('Checkpoint');
	});

	it('applies forward patches from checkpoint to target', () => {
		const initial = makeState({ name: 'Initial' });
		const changed = makeState({ name: 'Changed' });
		const { patches } = generatePatches(initial, changed);

		const entries: HistoryEntry[] = [
			{ type: 'checkpoint', state: initial },
			{ type: 'delta', patches, reversePatches: [] },
		];

		const result = reconstructState(entries, 1);
		expect(result.name).toBe('Changed');
	});

	it('applies multiple deltas in sequence', () => {
		const s1 = makeState({ name: 'First' });
		const s2 = makeState({ name: 'Second' });
		const s3 = makeState({ name: 'Third' });

		const p1 = generatePatches(s1, s2);
		const p2 = generatePatches(s2, s3);

		const entries: HistoryEntry[] = [
			{ type: 'checkpoint', state: s1 },
			{ type: 'delta', patches: p1.patches, reversePatches: p1.reversePatches },
			{ type: 'delta', patches: p2.patches, reversePatches: p2.reversePatches },
		];

		const result = reconstructState(entries, 2);
		expect(result.name).toBe('Third');
	});

	it('does not mutate checkpoint state', () => {
		const initial = makeState({ name: 'Initial' });
		const changed = makeState({ name: 'Changed' });
		const { patches } = generatePatches(initial, changed);

		const entries: HistoryEntry[] = [
			{ type: 'checkpoint', state: initial },
			{ type: 'delta', patches, reversePatches: [] },
		];

		reconstructState(entries, 1);
		// Original checkpoint should be unchanged
		expect((entries[0] as HistoryCheckpoint).state.name).toBe('Initial');
	});

	it('finds nearest checkpoint when target is after one', () => {
		const s1 = makeState({ name: 'First' });
		const s2 = makeState({ name: 'Second' });
		const s3 = makeState({ name: 'Third' });
		const s4 = makeState({ name: 'Fourth' });

		const p1 = generatePatches(s1, s2);
		const _p2 = generatePatches(s2, s3);
		const p3 = generatePatches(s3, s4);

		const entries: HistoryEntry[] = [
			{ type: 'checkpoint', state: s1 },
			{ type: 'delta', patches: p1.patches, reversePatches: p1.reversePatches },
			{ type: 'checkpoint', state: s3 }, // checkpoint at state 3
			{ type: 'delta', patches: p3.patches, reversePatches: p3.reversePatches },
		];

		// Should reconstruct from checkpoint at index 2
		const result = reconstructState(entries, 3);
		expect(result.name).toBe('Fourth');
	});
});
