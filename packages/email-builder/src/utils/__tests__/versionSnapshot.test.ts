import { describe, it, expect } from 'vitest';
import { ref, nextTick } from 'vue';
import {
	deserializeVersionSnapshot,
	formatSnapshotSize,
	parseSnapshotBlocks,
	serializeHistoryState,
	snapshotMatchesState,
} from '../versionSnapshot';
import { useHistory } from '../../composables/useHistory';
import type { EditorBlock } from '../../types';

/**
 * The persisted-history serialization seam. The load-bearing property is the
 * last block of tests: restoring a snapshot must go through the same refs an
 * ordinary edit does, so the restore is itself undoable.
 */

const block = (id: string, html: string): EditorBlock => ({
	id,
	type: 'text',
	content: { html, blockType: 'paragraph', fontSize: 16, textColor: '#000' },
});

const htmlOf = (b: EditorBlock | undefined) => (b?.content as { html: string } | undefined)?.html;

const state = (html: string) => ({
	blocks: [block('a', html)],
	name: 'Newsletter',
	subject: 'Hi',
});

describe('serializeHistoryState / deserializeVersionSnapshot', () => {
	it('round-trips editor state through a snapshot payload', () => {
		const original = state('one');
		const restored = deserializeVersionSnapshot(serializeHistoryState(original));
		expect(restored).toEqual(original);
	});

	it('serializes blocks to the same JSON the template row stores', () => {
		const payload = serializeHistoryState(state('one'));
		expect(payload.content).toBe(JSON.stringify(state('one').blocks));
		expect(payload).toMatchObject({ name: 'Newsletter', subject: 'Hi' });
	});

	it('restores name and subject even when the body is unusable', () => {
		const restored = deserializeVersionSnapshot({
			content: '{not json',
			name: 'Rescued',
			subject: 'Still here',
		});
		expect(restored).toEqual({ blocks: [], name: 'Rescued', subject: 'Still here' });
	});
});

describe('parseSnapshotBlocks', () => {
	it('returns [] for empty, non-array and malformed content', () => {
		expect(parseSnapshotBlocks('')).toEqual([]);
		expect(parseSnapshotBlocks('null')).toEqual([]);
		expect(parseSnapshotBlocks('{"blocks":[]}')).toEqual([]);
		expect(parseSnapshotBlocks('[')).toEqual([]);
	});

	it('drops entries that are not block-shaped and keeps the rest', () => {
		const content = JSON.stringify([
			block('a', 'one'),
			null,
			42,
			{ type: 'text' },
			block('b', 'two'),
		]);
		expect(parseSnapshotBlocks(content).map((b) => b.id)).toEqual(['a', 'b']);
	});
});

describe('snapshotMatchesState', () => {
	it('detects an identical snapshot and any divergence', () => {
		const current = state('one');
		expect(snapshotMatchesState(serializeHistoryState(current), current)).toBe(true);
		expect(snapshotMatchesState(serializeHistoryState(state('two')), current)).toBe(false);
		expect(
			snapshotMatchesState({ ...serializeHistoryState(current), subject: 'Different' }, current)
		).toBe(false);
	});
});

describe('formatSnapshotSize', () => {
	it('scales bytes to a compact label', () => {
		expect(formatSnapshotSize(0)).toBe('0 B');
		expect(formatSnapshotSize(512)).toBe('512 B');
		expect(formatSnapshotSize(2048)).toBe('2.0 KB');
		expect(formatSnapshotSize(1024 * 40)).toBe('40 KB');
		expect(formatSnapshotSize(1024 * 1024 * 3)).toBe('3.0 MB');
	});
});

// Real timers with a tiny debounce, matching useHistory.test.ts's harness.
const DEBOUNCE = 2;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('restoring a snapshot into the editor', () => {
	it('is recorded as an undoable edit, not an unrecoverable jump', async () => {
		const blocks = ref<EditorBlock[]>([block('a', 'original')]);
		const name = ref('Newsletter');
		const subject = ref('Hi');
		const history = useHistory(blocks, name, subject, {
			debounceMs: DEBOUNCE,
			checkpointInterval: 10,
		});

		// The user edits, then saves — the save is what the backend snapshots.
		blocks.value = [block('a', 'edited')];
		await nextTick();
		await sleep(DEBOUNCE + 5);
		await nextTick();
		const snapshot = serializeHistoryState({
			blocks: blocks.value,
			name: name.value,
			subject: subject.value,
		});

		// …then keeps editing past it.
		blocks.value = [block('a', 'later work')];
		name.value = 'Renamed';
		await nextTick();
		await sleep(DEBOUNCE + 5);
		await nextTick();

		// Restore = assign the deserialized state to the very same refs.
		const restored = deserializeVersionSnapshot(snapshot);
		blocks.value = restored.blocks;
		name.value = restored.name;
		subject.value = restored.subject;
		await nextTick();
		await sleep(DEBOUNCE + 5);
		await nextTick();

		expect(htmlOf(blocks.value[0])).toBe('edited');
		expect(name.value).toBe('Newsletter');

		// Undo walks back out of the restore to the work it replaced — nothing
		// is lost by restoring the wrong version.
		history.undo();
		expect(htmlOf(blocks.value[0])).toBe('later work');
		expect(name.value).toBe('Renamed');
	});
});
