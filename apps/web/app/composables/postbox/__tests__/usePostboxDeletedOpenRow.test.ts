/**
 * The delete broadcast between the list verbs and the list that knows what is
 * open: which list acts, which neighbour it picks, when it goes back.
 *
 * Then the bulk bar's three deletes (Delete, Delete forever, Move to Trash),
 * with the mutation held open so the order "leave first, then send" and the
 * failure path are both observable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { effectScope, ref } from 'vue';
import type { PostboxAutoAdvanceMode } from '~/utils/postboxAutoAdvance';
import { leaveDeletedOpenRow, usePostboxDeletedOpenRowGuard } from '../usePostboxDeletedOpenRow';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

type Outcome = { ok: boolean; result: unknown };
const events: string[] = [];
const pending: Array<(outcome: Outcome) => void> = [];
let stateBuckets: Map<string, unknown>;

beforeEach(() => {
	events.length = 0;
	pending.length = 0;
	stateBuckets = new Map();
	vi.stubGlobal('useState', (key: string, init: () => unknown) => {
		if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
		return stateBuckets.get(key);
	});
	vi.stubGlobal('useI18n', () => ({ t: (k: string) => k }));
	vi.stubGlobal('useBackendOperation', () => ({
		run: vi.fn(
			(args: { messageIds: string[] }) =>
				new Promise<Outcome>((resolve) => {
					events.push(`send ${args.messageIds.join(',')}`);
					pending.push(resolve);
				})
		),
		isLoading: ref(false),
	}));
	vi.stubGlobal('usePostboxTriageUndo', () => ({ registerMoveBack: vi.fn() }));
});

const { usePostboxBulkActions } = await import('../usePostboxBulkActions');

/** Register a list in its own scope; returns its leave log and a disposer. */
function list(opts: {
	ordered: string[];
	open: string | null;
	mode?: PostboxAutoAdvanceMode;
	name?: string;
}) {
	const scope = effectScope();
	const leave = vi.fn((left: string, target: string | null) => {
		events.push(`${opts.name ?? 'list'} leave ${left} -> ${target}`);
		return () => events.push(`${opts.name ?? 'list'} back ${left}`);
	});
	scope.run(() =>
		usePostboxDeletedOpenRowGuard({
			orderedIds: () => opts.ordered,
			openId: () => opts.open,
			autoAdvance: () => opts.mode ?? 'next',
			leave,
		})
	);
	return { leave, dispose: () => scope.stop() };
}

describe('leaveDeletedOpenRow', () => {
	it('is a no-op with no list mounted', () => {
		expect(() => leaveDeletedOpenRow(['a'])(['a'])).not.toThrow();
	});

	it('moves past the other rows of the same delete', () => {
		const l = list({ ordered: ['a', 'b', 'c', 'd'], open: 'b' });
		leaveDeletedOpenRow(['b', 'c']);
		expect(l.leave).toHaveBeenCalledWith('b', 'd');
		l.dispose();
	});

	it('honours previous and back-to-list', () => {
		const prev = list({ ordered: ['a', 'b', 'c'], open: 'b', mode: 'previous' });
		leaveDeletedOpenRow(['b']);
		expect(prev.leave).toHaveBeenCalledWith('b', 'a');
		prev.dispose();
		const back = list({ ordered: ['a', 'b', 'c'], open: 'b', mode: 'back-to-list' });
		leaveDeletedOpenRow(['b']);
		expect(back.leave).toHaveBeenCalledWith('b', null);
		back.dispose();
	});

	it('ignores a delete that does not include the open row', () => {
		const l = list({ ordered: ['a', 'b', 'c'], open: 'b' });
		leaveDeletedOpenRow(['a', 'c']);
		expect(l.leave).not.toHaveBeenCalled();
		const nothingOpen = list({ ordered: ['a', 'b'], open: null });
		leaveDeletedOpenRow(['a', 'b']);
		expect(nothingOpen.leave).not.toHaveBeenCalled();
		l.dispose();
		nothingOpen.dispose();
	});

	it('lets the list that renders the open row act, and only that one', () => {
		const offscreen = list({ ordered: ['x'], open: 'b', name: 'offscreen' });
		const onscreen = list({ ordered: ['a', 'b', 'c'], open: 'b', name: 'onscreen' });
		leaveDeletedOpenRow(['b']);
		expect(events).toEqual(['onscreen leave b -> c']);
		offscreen.dispose();
		onscreen.dispose();
	});

	it('closes when the open row is deleted without being on screen', () => {
		const l = list({ ordered: ['a', 'c'], open: 'b' });
		leaveDeletedOpenRow(['b']);
		expect(l.leave).toHaveBeenCalledWith('b', null);
		l.dispose();
	});

	it('goes back only when the open row is among the failed ids', () => {
		const l = list({ ordered: ['a', 'b', 'c', 'd'], open: 'b' });
		const returnTo = leaveDeletedOpenRow(['b', 'c']);
		returnTo(['c']);
		expect(events).toEqual(['list leave b -> d']);
		returnTo(['b', 'c']);
		expect(events).toEqual(['list leave b -> d', 'list back b']);
		l.dispose();
	});

	it('forgets a list once its scope is disposed', () => {
		const l = list({ ordered: ['a', 'b'], open: 'a' });
		l.dispose();
		leaveDeletedOpenRow(['a']);
		expect(l.leave).not.toHaveBeenCalled();
	});
});

describe('usePostboxBulkActions deletes', () => {
	function setup(selection: string[]) {
		const l = list({ ordered: ['a', 'b', 'c', 'd'], open: 'b' });
		const bulk = usePostboxBulkActions(ref('mbx' as never));
		bulk.selectMany(selection as never[]);
		return { l, bulk };
	}

	it('Delete with the open row selected leaves it before the trash is sent', async () => {
		const { l, bulk } = setup(['a', 'b']);
		const done = bulk.trashSelected();
		expect(events).toEqual(['list leave b -> c', 'send a,b']);
		pending[0]!({ ok: true, result: { moved: [] } });
		await done;
		expect(events).toHaveLength(2);
		expect(bulk.count.value).toBe(0);
		l.dispose();
	});

	it('a failed Delete goes back to the open row and keeps the selection', async () => {
		const { l, bulk } = setup(['b', 'c']);
		const done = bulk.trashSelected();
		pending[0]!({ ok: false, result: null });
		await done;
		expect(events).toEqual(['list leave b -> d', 'send b,c', 'list back b']);
		expect(bulk.count.value).toBe(2);
		l.dispose();
	});

	it('Delete without the open row leaves the reader alone', async () => {
		const { l, bulk } = setup(['c', 'd']);
		const done = bulk.trashSelected();
		pending[0]!({ ok: true, result: { moved: [] } });
		await done;
		expect(l.leave).not.toHaveBeenCalled();
		l.dispose();
	});

	it('Delete forever leaves the open row it was asked about', async () => {
		const { l, bulk } = setup([]);
		const done = bulk.purgeSelected(['b'] as never[]);
		expect(events).toEqual(['list leave b -> c', 'send b']);
		pending[0]!({ ok: false, result: null });
		await done;
		expect(events.at(-1)).toBe('list back b');
		l.dispose();
	});

	it('a move counts as a delete only when the target is Trash', async () => {
		const { l, bulk } = setup(['b']);
		let done = bulk.moveSelected('fld_archive' as never);
		pending[0]!({ ok: true, result: { moved: [] } });
		await done;
		expect(l.leave).not.toHaveBeenCalled();

		bulk.selectMany(['b'] as never[]);
		done = bulk.moveSelected('fld_trash' as never, true);
		expect(l.leave).toHaveBeenCalledWith('b', 'c');
		pending[1]!({ ok: true, result: { moved: [] } });
		await done;
		l.dispose();
	});
});
