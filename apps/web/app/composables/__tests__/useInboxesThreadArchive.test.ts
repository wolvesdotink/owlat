/**
 * useInboxesThreadArchive — Archive (and the sweep from it) on the all-inboxes
 * list, where Today's "Filed away" mailbox tiles land.
 *
 * Rows are conversations, so what is pinned is that the call carries THREAD
 * ids (never a stand-in message id), that team-inbox rows are never archived,
 * that a sweep does nothing before release and archives exactly the range
 * once, that one Undo covers it all and puts the mail back in bounded moves,
 * that a conversation the server left unfinished leads the next call, and
 * that a row comes back whenever its conversation is still in the Inbox once
 * the calls settle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope } from 'vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const registerMoveBack = vi.fn();
vi.mock('../postbox/usePostboxTriageUndo', () => ({
	usePostboxTriageUndo: () => ({ registerMoveBack }),
}));

const ARCHIVE = 'dashboard.inboxes.archiveOperation';
const UNDO_MOVE = 'dashboard.inboxes.archiveUndoOperation';
const ROW_PX = 50;

type Row = { key: string; archive: { threadId: string } | null };
type Request = { threadId: string; cursor?: string };

let runs: Array<{ label: string; args: { threads?: Request[]; messageIds?: string[] } }>;
let outcomes: Array<{ ok: boolean; result?: unknown }>;
let scope: EffectScope;
let list: HTMLElement;

beforeEach(() => {
	runs = [];
	outcomes = [];
	registerMoveBack.mockClear();
	vi.useFakeTimers();
	vi.stubGlobal('useI18n', () => ({
		t: (key: string, params?: { count?: number }) =>
			params?.count === undefined ? key : `${key}:${params.count}`,
	}));
	vi.stubGlobal('useBackendOperation', (_fn: unknown, opts: { label: () => string }) => ({
		run: vi.fn(async (args: { threads?: Request[]; messageIds?: string[] }) => {
			runs.push({ label: opts.label(), args });
			return outcomes.shift() ?? movedFor((args.threads ?? []).map((thread) => thread.threadId));
		}),
	}));
});

afterEach(() => {
	scope?.stop();
	list?.remove();
	vi.useRealTimers();
});

type ThreadOutcome = {
	threadId: string;
	moved: number;
	isDone: boolean;
	cursor: string | null;
	hasLeftInbox: boolean;
};

/** A successful call: `moved` messages per listed thread, with per-thread outcomes. */
function callResult(threads: Array<Partial<ThreadOutcome> & { threadId: string }>) {
	const outcomes = threads.map((thread) => ({
		moved: 1,
		isDone: true,
		cursor: null,
		hasLeftInbox: true,
		...thread,
	}));
	return {
		ok: true,
		result: {
			ok: true,
			moved: outcomes.flatMap((thread) =>
				Array.from({ length: thread.moved }, (_, i) => ({
					messageId: `m-${thread.threadId}-${i}`,
					sourceFolderId: 'inbox',
				}))
			),
			threads: outcomes,
		},
	};
}

/** A successful archive that moved one message per thread and cleared each from the Inbox. */
function movedFor(threadIds: string[]) {
	return callResult(threadIds.map((threadId) => ({ threadId })));
}

const sent = (i = 0) => runs[i]!.args.threads!.map((thread) => thread.threadId);

const mailRow = (id: string): Row => ({ key: `mail:mbx:${id}`, archive: { threadId: id } });
const teamRow = (id: string): Row => ({ key: `team:${id}`, archive: null });

function buildList(rows: Row[]) {
	list = document.createElement('ul');
	for (const [i, row] of rows.entries()) {
		const li = document.createElement('li');
		li.dataset['sweepRow'] = row.key;
		li.getBoundingClientRect = () => ({ top: i * ROW_PX, bottom: (i + 1) * ROW_PX }) as DOMRect;
		list.appendChild(li);
	}
	document.body.appendChild(list);
}

function pointer(type: string, y: number): PointerEvent {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		clientX: { value: 10 },
		clientY: { value: y },
		pointerType: { value: 'mouse' },
		pointerId: { value: 1 },
		isPrimary: { value: true },
		button: { value: 0 },
		shiftKey: { value: false },
		metaKey: { value: false },
		ctrlKey: { value: false },
		altKey: { value: false },
	});
	return event as PointerEvent;
}

const yOf = (i: number) => i * ROW_PX + ROW_PX / 2;

async function mount(initial: Row[]) {
	const { useInboxesThreadArchive } = await import('../useInboxesThreadArchive');
	const rows = ref(initial);
	buildList(initial);
	const listEl = ref<HTMLElement | null>(list);
	const scopeKey = ref('all');
	scope = effectScope();
	const archive = scope.run(() =>
		useInboxesThreadArchive({ rows: rows as never, listEl, scopeKey: () => scopeKey.value })
	)!;
	return { rows, scopeKey, ...archive };
}

/** Press row `from`'s Archive button and drag to row `to`. */
function drag(api: Awaited<ReturnType<typeof mount>>, from: number, to: number) {
	const key = api.rows.value[from]!.key;
	api.sweep.start('archive', key, pointer('pointerdown', yOf(from)));
	const step = to >= from ? 1 : -1;
	window.dispatchEvent(pointer('pointermove', yOf(from) + step * 8));
	for (let i = from; i !== to + step; i += step)
		window.dispatchEvent(pointer('pointermove', yOf(i)));
}

const release = (row: number) => window.dispatchEvent(pointer('pointerup', yOf(row)));

/** Let the awaited mutation calls settle (microtasks only, no clock). */
async function settle() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('useInboxesThreadArchive', () => {
	it("archives a row's conversation by its thread id, with one Undo", async () => {
		const api = await mount([mailRow('t1'), mailRow('t2')]);

		expect(await api.archiveRow(api.rows.value[0]!)).toBe(true);

		expect(runs).toEqual([{ label: ARCHIVE, args: { threads: [{ threadId: 't1' }] } }]);
		expect(api.visible.value.map((r) => r.key)).toEqual(['mail:mbx:t2']);
		expect(registerMoveBack).toHaveBeenCalledTimes(1);
		expect(registerMoveBack.mock.calls[0]![0]).toMatchObject({
			label: 'dashboard.inboxes.archivedUndo:1',
			kind: 'archived',
			moved: [{ messageId: 'm-t1-0', sourceFolderId: 'inbox' }],
		});
	});

	it('brings the row back when the archive fails', async () => {
		const api = await mount([mailRow('t1'), mailRow('t2')]);
		outcomes = [{ ok: false }];

		expect(await api.archiveRow(api.rows.value[0]!)).toBe(false);

		expect(api.visible.value.map((r) => r.key)).toEqual(['mail:mbx:t1', 'mail:mbx:t2']);
		expect(registerMoveBack).not.toHaveBeenCalled();
	});

	it('never archives a team-inbox row', async () => {
		const api = await mount([teamRow('x')]);
		expect(await api.archiveRow(api.rows.value[0]!)).toBe(false);
		expect(runs).toEqual([]);
	});

	it('a sweep archives exactly the range, once, on release, skipping team rows', async () => {
		const api = await mount([
			mailRow('t1'),
			mailRow('t2'),
			teamRow('x'),
			mailRow('t3'),
			mailRow('t4'),
		]);

		drag(api, 0, 3);
		expect(runs).toEqual([]);
		expect(api.sweep.status.value).toEqual({ mark: 'archive', count: 3 });
		expect(api.sweep.markOf('team:x')).toBeNull();

		release(3);
		await settle();

		expect(runs).toHaveLength(1);
		expect(sent()).toEqual(['t1', 't2', 't3']);
		expect(registerMoveBack).toHaveBeenCalledTimes(1);
		expect(api.visible.value.map((r) => r.key)).toEqual(['team:x', 'mail:mbx:t4']);
	});

	it('a filter change mid-sweep cancels it', async () => {
		const api = await mount([mailRow('t1'), mailRow('t2'), mailRow('t3')]);
		drag(api, 0, 2);
		api.scopeKey.value = 'mbx';
		await nextTick();
		release(2);
		await nextTick();
		expect(runs).toEqual([]);
	});

	it('splits a range longer than one call takes, under one Undo', async () => {
		const many = Array.from({ length: 150 }, (_, i) => mailRow(`t${i}`));
		const api = await mount(many);

		api.sweep.start('archive', many[0]!.key, pointer('pointerdown', yOf(0)));
		window.dispatchEvent(pointer('pointermove', yOf(0) + 8));
		window.dispatchEvent(pointer('pointermove', yOf(149)));
		release(149);
		await settle();

		expect(registerMoveBack).toHaveBeenCalledTimes(1);
		expect(runs.map((r) => r.args.threads!.length)).toEqual([100, 50]);
		expect(registerMoveBack.mock.calls[0]![0].moved).toHaveLength(150);
		expect(registerMoveBack.mock.calls[0]![0].label).toBe('dashboard.inboxes.archivedUndo:150');
	});

	it('calls again for a conversation the server left unfinished, from where it stopped', async () => {
		const api = await mount([mailRow('t1'), mailRow('t2')]);
		const cursor = 'page-2';
		outcomes = [
			callResult([{ threadId: 't1', moved: 3, isDone: false, cursor, hasLeftInbox: false }]),
			callResult([{ threadId: 't1', moved: 2 }]),
		];

		expect(await api.archiveRow(api.rows.value[0]!)).toBe(true);

		expect(runs.map((r) => r.args.threads)).toEqual([
			[{ threadId: 't1' }],
			[{ threadId: 't1', cursor }],
		]);
		expect(api.visible.value.map((r) => r.key)).toEqual(['mail:mbx:t2']);
		expect(registerMoveBack).toHaveBeenCalledTimes(1);
		expect(registerMoveBack.mock.calls[0]![0].moved).toHaveLength(5);
		expect(registerMoveBack.mock.calls[0]![0].label).toBe('dashboard.inboxes.archivedUndo:1');
	});

	it('resumes every unfinished conversation of a sweep under one Undo', async () => {
		const api = await mount([mailRow('t1'), mailRow('t2'), mailRow('t3')]);
		const cursor = 'page-2';
		outcomes = [
			callResult([
				{ threadId: 't1', moved: 2, isDone: false, cursor, hasLeftInbox: false },
				{ threadId: 't2', moved: 4 },
				{ threadId: 't3', moved: 0, isDone: false, cursor: null, hasLeftInbox: false },
			]),
			callResult([
				{ threadId: 't1', moved: 1 },
				{ threadId: 't3', moved: 1 },
			]),
		];

		drag(api, 0, 2);
		release(2);
		await settle();

		expect(runs.map((r) => r.args.threads)).toEqual([
			[{ threadId: 't1' }, { threadId: 't2' }, { threadId: 't3' }],
			[{ threadId: 't1', cursor }, { threadId: 't3' }],
		]);
		expect(registerMoveBack).toHaveBeenCalledTimes(1);
		expect(registerMoveBack.mock.calls[0]![0].moved).toHaveLength(8);
		expect(registerMoveBack.mock.calls[0]![0].label).toBe('dashboard.inboxes.archivedUndo:3');
		expect(api.visible.value).toEqual([]);
	});

	it('brings back a conversation the call left in the Inbox, and keeps it after a list update', async () => {
		const api = await mount([mailRow('t1'), mailRow('t2')]);
		outcomes = [callResult([{ threadId: 't1', moved: 0, hasLeftInbox: false }])];

		expect(await api.archiveRow(api.rows.value[0]!)).toBe(true);

		expect(api.visible.value.map((r) => r.key)).toEqual(['mail:mbx:t1', 'mail:mbx:t2']);
		api.rows.value = [...api.rows.value];
		await nextTick();
		expect(api.visible.value.map((r) => r.key)).toEqual(['mail:mbx:t1', 'mail:mbx:t2']);
		expect(registerMoveBack).not.toHaveBeenCalled();
	});

	it('brings back a partly archived conversation (snoozed mail stays) but keeps its Undo', async () => {
		const api = await mount([mailRow('t1'), mailRow('t2'), mailRow('t3')]);
		outcomes = [
			callResult([
				{ threadId: 't1', moved: 1 },
				{ threadId: 't2', moved: 2, hasLeftInbox: false },
				{ threadId: 't3', moved: 0, hasLeftInbox: false },
			]),
		];

		drag(api, 0, 2);
		release(2);
		await settle();

		expect(api.visible.value.map((r) => r.key)).toEqual(['mail:mbx:t2', 'mail:mbx:t3']);
		expect(registerMoveBack.mock.calls[0]![0]).toMatchObject({
			label: 'dashboard.inboxes.archivedUndo:2',
		});
		expect(registerMoveBack.mock.calls[0]![0].moved).toHaveLength(3);
	});

	it('counts only the conversations archived when one of the split calls fails', async () => {
		const many = Array.from({ length: 101 }, (_, i) => mailRow(`t${i}`));
		const api = await mount(many);
		outcomes = [{ ok: false }, movedFor(['t100'])];

		drag(api, 0, 100);
		release(100);
		await settle();

		expect(api.visible.value).toHaveLength(100);
		expect(api.visible.value.some((r) => r.key === 'mail:mbx:t100')).toBe(false);
		expect(registerMoveBack.mock.calls[0]![0].label).toBe('dashboard.inboxes.archivedUndo:1');
	});

	it('puts unfinished conversations ahead of the rest of a split sweep', async () => {
		const many = Array.from({ length: 150 }, (_, i) => mailRow(`t${i}`));
		const api = await mount(many);
		const cursor = 'page-2';
		outcomes = [
			callResult(
				many
					.slice(0, 100)
					.map((row, i) =>
						i === 0
							? { threadId: row.archive!.threadId, isDone: false, cursor, hasLeftInbox: false }
							: { threadId: row.archive!.threadId }
					)
			),
		];

		drag(api, 0, 149);
		release(149);
		await settle();

		expect(runs.map((r) => r.args.threads!.length)).toEqual([100, 51]);
		expect(runs[1]!.args.threads![0]).toEqual({ threadId: 't0', cursor });
		expect(runs[1]!.args.threads!.slice(1).every((thread) => !('cursor' in thread))).toBe(true);
	});

	it('registers a long archive under its one Undo, which puts each bounded group back with `move`', async () => {
		const api = await mount([mailRow('t1')]);
		outcomes = [callResult([{ threadId: 't1', moved: 250 }])];
		await api.archiveRow(api.rows.value[0]!);
		expect(registerMoveBack).toHaveBeenCalledTimes(1);
		const { moved, runMove } = registerMoveBack.mock.calls[0]![0];
		expect(moved).toHaveLength(250);
		runs = [];

		// registerMoveBack splits the provenance into groups of at most 100.
		const group = {
			messageIds: moved.slice(0, 100).map((m: { messageId: string }) => m.messageId),
			targetFolderId: 'inbox',
		};
		await runMove(group);

		expect(runs).toEqual([{ label: UNDO_MOVE, args: group }]);
	});
});
