import { describe, it, expect } from 'vitest';
import {
	MAX_COEDIT_OPS_PER_BATCH,
	applyCoeditOps,
	type CoeditDocument,
	type CoeditOp,
} from '@owlat/shared/coeditOps';
import { CoeditSync, type CoeditServerState } from '../coeditSync';

interface Block {
	id: string;
	text: string;
}

const b = (id: string, text = id): Block => ({ id, text });

const doc = (blocks: Block[], subject = 'S'): CoeditDocument<Block> => ({
	blocks,
	fields: { subject },
});

const server = (
	version: number,
	d: CoeditDocument<Block>,
	extra: Partial<CoeditServerState<Block>> = {}
): CoeditServerState<Block> => ({
	sessionId: 's1',
	version,
	savedVersion: 1,
	baseRevision: 0,
	doc: d,
	...extra,
});

/** Start a sync hydrated at `initial` (version 1). */
function start(initial: CoeditDocument<Block>) {
	const sync = new CoeditSync<Block>();
	const first = sync.receive(server(1, initial), doc([]));
	expect(first).toEqual({ kind: 'hydrate', doc: initial });
	return sync;
}

/** What the canvas shows after applying a receive result. */
function applyReceive(
	local: CoeditDocument<Block>,
	result: ReturnType<CoeditSync<Block>['receive']>
): CoeditDocument<Block> {
	if (result === null) return local;
	if (result.kind === 'hydrate') return result.doc;
	return applyCoeditOps(local, result.ops);
}

describe('CoeditSync', () => {
	it("sends this tab's edits as operations based on the version it saw", () => {
		const sync = start(doc([b('a'), b('b')]));
		const local = doc([b('a', 'A!'), b('b')]);
		const out = sync.outgoing(local);
		expect(out).toEqual({
			sessionId: 's1',
			ops: [{ op: { kind: 'update', block: b('a', 'A!'), afterId: null }, baseVersion: 1 }],
		});
	});

	it("merges other people's edits and keeps unsent local ones", () => {
		const sync = start(doc([b('a'), b('b')]));
		const local = doc([b('a', 'mine'), b('b')]);
		const result = sync.receive(server(2, doc([b('a'), b('b', 'theirs'), b('c')], 'New')), local);
		expect(result?.kind).toBe('merge');
		const shown = applyReceive(local, result);
		expect(shown).toEqual(doc([b('a', 'mine'), b('b', 'theirs'), b('c')], 'New'));
		// The unsent edit still goes out, still based on the version it was made on.
		expect(sync.outgoing(shown)?.ops).toEqual([
			{ op: { kind: 'update', block: b('a', 'mine'), afterId: null }, baseVersion: 1 },
		]);
	});

	it('keeps one send in flight and waits for the server to include it', () => {
		const sync = start(doc([b('a')]));
		let local = doc([b('a', 'one')]);
		const first = sync.outgoing(local)!;
		sync.sent(first);
		local = doc([b('a', 'two')]);
		expect(sync.outgoing(local)).toBeNull();

		sync.acked(2);
		// The subscription has not delivered version 2 yet.
		expect(sync.outgoing(local)).toBeNull();

		const echoed = sync.receive(server(2, doc([b('a', 'one')])), local);
		expect(echoed).toEqual({ kind: 'merge', ops: [] });
		// The next edit builds on this tab's own write.
		expect(sync.outgoing(local)?.ops[0]?.baseVersion).toBe(2);
	});

	it('re-sends edits whose send failed', () => {
		const sync = start(doc([b('a')]));
		const local = doc([b('a', 'x')]);
		const out = sync.outgoing(local)!;
		sync.sent(out);
		sync.failed();
		expect(sync.outgoing(local)?.ops).toEqual(out.ops);
	});

	it('ignores states older than the one it has, but takes their bookkeeping', () => {
		const sync = start(doc([b('a')]));
		const local = doc([b('a')]);
		sync.receive(server(3, doc([b('a', 'v3')])), local);
		expect(sync.receive(server(2, doc([b('a', 'v2')])), local)).toBeNull();
		expect(sync.receive(server(3, doc([b('a', 'v3')]), { savedVersion: 3 }), local)).toBeNull();
		expect(sync.server?.savedVersion).toBe(3);
	});

	it('pins the version a block was taken at for the edits made while holding it', () => {
		const sync = start(doc([b('a')]));
		sync.pin('block:a');
		// Someone else's write to the block lands while this tab has the text open.
		const local = doc([b('a')]);
		const shown = applyReceive(local, sync.receive(server(2, doc([b('a', 'theirs')])), local));
		// The inline editor closes and commits on top.
		const committed = doc([{ ...shown.blocks[0]!, text: 'mine' }]);
		expect(sync.outgoing(committed)?.ops[0]?.baseVersion).toBe(1);
		sync.unpin('block:a');
		expect(sync.outgoing(committed)?.ops[0]?.baseVersion).toBe(2);
	});

	it('shows the next state as it is after adoptNextState, dropping unsent edits', () => {
		const sync = start(doc([b('a')]));
		sync.adoptNextState();
		const result = sync.receive(server(2, doc([b('a', 'saved')])), doc([b('a', 'unsent')]));
		expect(result).toEqual({ kind: 'hydrate', doc: doc([b('a', 'saved')]) });
	});

	it('restores unsaved work into a new session that replaced an ended one', () => {
		const sync = start(doc([b('a')]));
		const shared = doc([b('a', 'shared draft'), b('n')]);
		sync.receive(server(5, shared), shared);
		// The old session ended (swept) and a new one was seeded from the saved row.
		const fresh = server(1, doc([b('a')]), { sessionId: 's2', savedVersion: 1 });
		const result = sync.receive(fresh, shared);
		expect(applyReceive(shared, result)).toEqual(shared);
		expect(sync.outgoing(shared)?.sessionId).toBe('s2');
		expect(
			sync
				.outgoing(shared)
				?.ops.map((o) => o.op.kind)
				.sort()
		).toEqual(['insert', 'update']);
	});

	it('ignores the acknowledgement of a send to a session it has left', () => {
		const sync = start(doc([b('a')]));
		const local = doc([b('a', 'x')]);
		sync.sent(sync.outgoing(local)!);
		sync.receive(server(1, doc([b('a')]), { sessionId: 's2' }), local);
		sync.acked(99);
		expect(sync.outgoing(local)?.sessionId).toBe('s2');
	});

	it('sends a change bigger than one batch in several, each building on the last', () => {
		const initial = doc([b('a'), b('b')]);
		const sync = start(initial);
		// Replace everything with many new blocks (an HTML import, say).
		const many = Array.from({ length: MAX_COEDIT_OPS_PER_BATCH + 40 }, (_, i) => b(`n${i}`));
		const local = doc(many, 'New subject');
		let serverDoc = initial;
		let version = 1;
		let batches = 0;
		for (let out = sync.outgoing(local); out !== null; out = sync.outgoing(local)) {
			expect(out.ops.length).toBeLessThanOrEqual(MAX_COEDIT_OPS_PER_BATCH);
			sync.sent(out);
			serverDoc = applyCoeditOps(
				serverDoc,
				out.ops.map((o) => o.op)
			);
			version += 1;
			batches += 1;
			sync.acked(version);
			expect(sync.receive(server(version, serverDoc), local)).toEqual({ kind: 'merge', ops: [] });
		}
		expect(batches).toBe(2);
		expect(serverDoc).toEqual(local);
	});

	it('shows what the server stored for its write instead of sending it again', () => {
		// The server sanitizes what it stores, so the echo of this tab's write
		// can differ from what the tab sent.
		const sync = start(doc([b('a'), b('b')]));
		const local = doc([b('a', 'a<br>b'), b('b')]);
		sync.sent(sync.outgoing(local)!);
		const stored = doc([b('a', 'a<br />b'), b('b')]);
		const echoed = sync.receive(server(2, stored), local);
		expect(echoed).toEqual({ kind: 'merge', ops: [] });
		expect(sync.settle(local)).toEqual([]);
		sync.acked(2);

		const settled = sync.settle(local);
		expect(settled).toEqual([{ kind: 'update', block: b('a', 'a<br />b'), afterId: null }]);
		const shown = applyCoeditOps(local, settled);
		expect(shown).toEqual(stored);
		expect(sync.outgoing(shown)).toBeNull();
		expect(sync.hasUnsent(shown)).toBe(false);
		// Once only.
		expect(sync.settle(local)).toEqual([]);
	});

	it('shows a later write by someone else to a block it just wrote', () => {
		const sync = start(doc([b('a')], 'S'));
		const local = doc([b('a', 'mine')], 'Mine');
		sync.sent(sync.outgoing(local)!);
		// Version 2 is this tab's write, version 3 someone else's on top of it.
		const merged = sync.receive(server(3, doc([b('a', 'theirs')], 'Theirs')), local);
		expect(applyReceive(local, merged)).toEqual(local);
		sync.acked(2);
		const shown = applyCoeditOps(local, sync.settle(local));
		expect(shown).toEqual(doc([b('a', 'theirs')], 'Theirs'));
		expect(sync.outgoing(shown)).toBeNull();
	});

	it('keeps an edit made after the write was sent', () => {
		const sync = start(doc([b('a')]));
		sync.sent(sync.outgoing(doc([b('a', 'one')]))!);
		const local = doc([b('a', 'two')]);
		sync.receive(server(2, doc([b('a', 'ONE')])), local);
		sync.acked(2);
		expect(sync.settle(local)).toEqual([]);
		expect(sync.outgoing(local)?.ops).toEqual([
			{ op: { kind: 'update', block: b('a', 'two'), afterId: null }, baseVersion: 2 },
		]);
	});

	it('waits for the server state that holds the acknowledged write', () => {
		const sync = start(doc([b('a')]));
		const local = doc([b('a', 'x ')]);
		sync.sent(sync.outgoing(local)!);
		sync.acked(2);
		expect(sync.settle(local)).toEqual([]);
		sync.receive(server(2, doc([b('a', 'x')])), local);
		expect(sync.settle(local)).toEqual([{ kind: 'update', block: b('a', 'x'), afterId: null }]);
	});

	it('reports unsent edits', () => {
		const sync = start(doc([b('a')]));
		expect(sync.hasUnsent(doc([b('a')]))).toBe(false);
		expect(sync.hasUnsent(doc([b('a', 'x')]))).toBe(true);
	});

	it('converges two tabs editing different blocks through one server', () => {
		const initial = doc([b('a'), b('b')]);
		let serverDoc = initial;
		let version = 1;
		const apply = (ops: { op: CoeditOp<Block> }[]) => {
			serverDoc = applyCoeditOps(
				serverDoc,
				ops.map((o) => o.op)
			);
			version += 1;
			return version;
		};
		const one = start(initial);
		const two = start(initial);
		let localOne = doc([b('a', 'from one'), b('b')]);
		let localTwo = doc([b('a'), b('b', 'from two')]);

		const outOne = one.outgoing(localOne)!;
		one.sent(outOne);
		one.acked(apply(outOne.ops));
		const outTwo = two.outgoing(localTwo)!;
		two.sent(outTwo);
		two.acked(apply(outTwo.ops));

		const state = server(version, serverDoc);
		localOne = applyReceive(localOne, one.receive(state, localOne));
		localTwo = applyReceive(localTwo, two.receive(state, localTwo));
		expect(localOne).toEqual(doc([b('a', 'from one'), b('b', 'from two')]));
		expect(localTwo).toEqual(localOne);
		expect(one.outgoing(localOne)).toBeNull();
		expect(two.outgoing(localTwo)).toBeNull();
	});
});
