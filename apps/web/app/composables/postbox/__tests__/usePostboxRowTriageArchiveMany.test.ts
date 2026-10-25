/**
 * usePostboxRowTriage.archiveMany — the verb an Archive sweep lands on. One
 * optimistic hide, one failure restore and ONE undo entry that puts every row
 * back; a long range goes in archive calls of at most 100 messages, so none
 * outgrows a transaction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

let runs: Array<{ label: string; args: unknown }>;
let outcome: { ok: boolean; result: unknown };
/** When set, answers each call in turn (overrides `outcome`). */
let outcomeFor: ((args: { messageIds: string[] }, call: number) => typeof outcome) | null;
let registerMoveBack: ReturnType<typeof vi.fn>;

beforeEach(() => {
	runs = [];
	outcome = { ok: true, result: null };
	outcomeFor = null;
	registerMoveBack = vi.fn();
	vi.stubGlobal('useI18n', () => ({
		t: (key: string, params?: { count?: number }) =>
			params?.count === undefined ? key : `${key}:${params.count}`,
	}));
	vi.stubGlobal('usePostboxTriageUndo', () => ({ registerMoveBack }));
	vi.stubGlobal('useConvexQuery', () => ({ data: ref(undefined), isLoading: ref(false) }));
	vi.stubGlobal('useBackendOperation', (_fn: unknown, opts: { label: () => string }) => ({
		run: vi.fn(async (args: unknown) => {
			runs.push({ label: opts.label(), args });
			return outcomeFor ? outcomeFor(args as { messageIds: string[] }, runs.length - 1) : outcome;
		}),
		isLoading: ref(false),
	}));
});

async function triage() {
	const { usePostboxRowTriage } = await import('../usePostboxRowTriage');
	const hide = vi.fn();
	const unhide = vi.fn();
	return {
		hide,
		unhide,
		...usePostboxRowTriage({ hide, unhide, setFlags: vi.fn(), clearFlags: vi.fn() }),
	};
}

const ARCHIVE = 'components.postbox.postboxThreadList.archiveOperation';

describe('archiveMany', () => {
	it('archives a short range in one mutation with one undo entry', async () => {
		const moved = [
			{ messageId: 'a', sourceFolderId: 'inbox' },
			{ messageId: 'b', sourceFolderId: 'inbox' },
			{ messageId: 'c', sourceFolderId: 'inbox' },
		];
		outcome = { ok: true, result: { ok: true, moved } };
		const t = await triage();

		expect(await t.archiveMany(['a', 'b', 'c'] as never[])).toBe(true);
		expect(runs).toEqual([{ label: ARCHIVE, args: { messageIds: ['a', 'b', 'c'] } }]);
		expect(t.hide.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
		expect(t.unhide).not.toHaveBeenCalled();
		expect(registerMoveBack).toHaveBeenCalledTimes(1);
		expect(registerMoveBack.mock.calls[0]![0]).toMatchObject({
			kind: 'archived',
			label: 'shared.postbox.usePostboxBulkActions.undo.archivedMany:3',
			moved,
		});
	});

	it('archives a long range in calls of at most 100, under one undo entry for all of it', async () => {
		const ids = Array.from({ length: 250 }, (_, i) => `m${i}`);
		outcomeFor = ({ messageIds }) => ({
			ok: true,
			result: {
				ok: true,
				moved: messageIds.map((messageId) => ({ messageId, sourceFolderId: 'inbox' })),
			},
		});
		const t = await triage();

		expect(await t.archiveMany(ids as never[])).toBe(true);

		expect(runs.map((r) => r.label)).toEqual([ARCHIVE, ARCHIVE, ARCHIVE]);
		expect(runs.map((r) => (r.args as { messageIds: string[] }).messageIds.length)).toEqual([
			100, 100, 50,
		]);
		expect(runs.flatMap((r) => (r.args as { messageIds: string[] }).messageIds)).toEqual(ids);
		expect(t.unhide).not.toHaveBeenCalled();
		expect(registerMoveBack).toHaveBeenCalledTimes(1);
		const entry = registerMoveBack.mock.calls[0]![0];
		expect(entry.label).toBe('shared.postbox.usePostboxBulkActions.undo.archivedMany:250');
		expect(entry.moved.map((m: { messageId: string }) => m.messageId)).toEqual(ids);
	});

	it('stops at a failed call: its rows and the unsent ones come back, the landed ones keep their undo', async () => {
		const ids = Array.from({ length: 250 }, (_, i) => `m${i}`);
		outcomeFor = ({ messageIds }, call) =>
			call === 1
				? { ok: false, result: null }
				: {
						ok: true,
						result: {
							ok: true,
							moved: messageIds.map((messageId) => ({ messageId, sourceFolderId: 'inbox' })),
						},
					};
		const t = await triage();

		expect(await t.archiveMany(ids as never[])).toBe(false);

		// The third call is never sent: one failure, one error.
		expect(runs).toHaveLength(2);
		expect(t.unhide.mock.calls.map(([id]) => id)).toEqual(ids.slice(100));
		expect(registerMoveBack).toHaveBeenCalledTimes(1);
		const entry = registerMoveBack.mock.calls[0]![0];
		expect(entry.label).toBe('shared.postbox.usePostboxBulkActions.undo.archivedMany:100');
		expect(entry.moved.map((m: { messageId: string }) => m.messageId)).toEqual(ids.slice(0, 100));
		t.unhide.mockClear();
		entry.after();
		expect(t.unhide.mock.calls.map(([id]) => id)).toEqual(ids.slice(0, 100));
	});

	it('restores every row when the archive fails', async () => {
		outcome = { ok: false, result: null };
		const t = await triage();
		expect(await t.archiveMany(['a', 'b'] as never[])).toBe(false);
		expect(t.unhide.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
		expect(registerMoveBack).not.toHaveBeenCalled();
	});

	it('sends nothing for an empty range', async () => {
		const t = await triage();
		expect(await t.archiveMany([])).toBe(false);
		expect(runs).toEqual([]);
	});

	it('a single row keeps the single-row undo label', async () => {
		outcome = { ok: true, result: { ok: true, moved: [{ messageId: 'a', sourceFolderId: 'f' }] } };
		const t = await triage();
		await t.archiveMsg('a' as never);
		expect(registerMoveBack.mock.calls[0]![0].label).toBe(
			'components.postbox.postboxThreadList.archivedUndo'
		);
	});
});
