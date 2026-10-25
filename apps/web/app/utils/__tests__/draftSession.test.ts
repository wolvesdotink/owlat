/**
 * A draft editor's session (`draftSession.ts`), as traces of events. After
 * every event the trace checks what must always hold (`checkStep`), not only
 * where it ends: no save goes out while a leave is decided or after Discard,
 * a closed editor starts nothing, only the server's acknowledgement covers
 * an edit (nothing else lets the page go or shows Saved), and each decision
 * settles once. Pure: no timers, no Vue.
 */
import { describe, expect, it } from 'vitest';
import {
	OWN_EDITS,
	createDraftSession,
	transition,
	type DraftEffect,
	type DraftEvent,
	type DraftLive,
	type DraftSessionState,
	type Fingerprints,
} from '../draftSession';
import {
	actionCurrent,
	atRisk,
	canAutosave,
	isDirty,
	pendingFields,
	saveStatus,
	serverHolds,
} from '../draftSessionSelectors';

type Step = DraftEvent | ((s: DraftSessionState) => DraftEvent);

/** Every invariant that holds after any event, whatever the trace. */
function checkStep(
	before: DraftSessionState,
	event: DraftEvent,
	after: DraftSessionState,
	effects: DraftEffect[]
) {
	const persisted = effects.filter((effect) => effect.type === 'persist');
	// A choice precedes any new dispatch: only an explicit save sends while one is open.
	if (before.leave !== null && event.type !== 'save-now') expect(persisted).toEqual([]);
	// Discarded work is never sent again.
	if (after.discarded) expect(persisted).toEqual([]);
	// One save at a time.
	if (before.flight !== null) expect(persisted).toEqual([]);
	// Closing, and a closed editor, start nothing: no save, no hydration.
	if (before.closed || event.type === 'close') {
		for (const effect of effects)
			expect(['persist', 'hydrate', 'timer']).not.toContain(effect.type);
	}
	// The base only moves through a hydration, an acknowledgement or a rebase.
	if (after.base !== before.base && before.base !== null && after.base !== null) {
		expect([
			'hydrated',
			'transfer',
			'rebaseline',
			'observed',
			'saved',
			'rebased',
			'reload',
			'live',
		]).toContain(event.type);
	}
	// A leave is let go only while nothing would be lost.
	for (const effect of effects) {
		if (effect.type === 'verdict' && effect.leave) expect(atRisk(after)).toBe(false);
	}
	// Leaving would lose exactly what the server does not hold, and nothing else shows Saved.
	if (after.enabled && !after.closed && !after.discarded) {
		expect(atRisk(after)).toBe(!serverHolds(after));
		if (!serverHolds(after)) expect(saveStatus(after)).not.toBe('saved');
	}
}

function trace(initial: DraftSessionState, steps: Step[]) {
	let state = initial;
	const effects: DraftEffect[] = [];
	const verdicts = new Map<number, number>();
	for (const step of steps) {
		const event = typeof step === 'function' ? step(state) : step;
		const next = transition(state, event);
		checkStep(state, event, next.state, next.effects);
		for (const effect of next.effects) {
			if (effect.type === 'verdict' || effect.type === 'settled') {
				// Each decision answers its router guard once, and its prompt's choice once.
				const key = effect.id * 10 + (effect.type === 'verdict' ? 1 : 2);
				verdicts.set(key, (verdicts.get(key) ?? 0) + 1);
				expect(verdicts.get(key)).toBe(1);
			}
		}
		state = next.state;
		effects.push(...next.effects);
	}
	return { state, effects };
}

const fp = (value: unknown) => JSON.stringify(value);
const doc = (name: string): Fingerprints => ({ name: fp(name) });

/** A loaded classic draft at `revision`, autosave on. */
function loaded(revision: number | null = 2, values = doc('Welcome')) {
	return trace(createDraftSession(), [
		{ type: 'enabled', enabled: true },
		{ type: 'hydrated', revision, values, fresh: false },
	]).state;
}

const edit = (name: string): DraftEvent => ({ type: 'edit', values: doc(name) });
const fire = (s: DraftSessionState): DraftEvent => ({ type: 'timer', id: s.saveTimer ?? -1 });
const landed =
	(receipt = {}) =>
	(s: DraftSessionState): DraftEvent => ({
		type: 'saved',
		flight: s.flight?.id ?? -1,
		receipt,
		at: 1_000,
	});
const refused =
	(conflict: number | null = null) =>
	(s: DraftSessionState): DraftEvent => ({
		type: 'save-failed',
		flight: s.flight?.id ?? -1,
		error: new Error('refused'),
		conflict,
	});
const ofType = <T extends DraftEffect['type']>(effects: DraftEffect[], type: T) =>
	effects.filter((effect): effect is Extract<DraftEffect, { type: T }> => effect.type === type);
const request = (id: number, destination = '/elsewhere'): DraftEvent => ({
	type: 'leave-requested',
	id,
	destination,
});
const ready = (id: number): DraftEvent => ({ type: 'leave-ready', id });
const verdictsOf = (effects: DraftEffect[]) =>
	ofType(effects, 'verdict').map((effect) => [effect.id, effect.leave]);

describe('draftSession: editing and saving', () => {
	it('counts an edit as pending and at risk from the moment it is made', () => {
		const { state, effects } = trace(loaded(), [edit('Hello')]);
		expect(state.localRevision).toBe(1);
		expect(atRisk(state)).toBe(true);
		expect(saveStatus(state)).toBe('saving');
		expect(ofType(effects, 'persist')).toEqual([]);
		expect(ofType(effects, 'timer')).toHaveLength(1);
	});

	it('saves the latest draft once the pause runs out, one save at a time', () => {
		const { state, effects } = trace(loaded(), [edit('A'), edit('AB'), fire]);
		const [flight] = ofType(effects, 'persist');
		expect(flight?.flight.values['name']).toBe(fp('AB'));
		expect(flight?.flight.baseRevision).toBe(2);
		expect(state.flight).not.toBeNull();
		// On its way is not saved: still at risk.
		expect(atRisk(state)).toBe(true);
	});

	it('acknowledges only what a save carried: a later edit stays pending and at risk', () => {
		const { state } = trace(loaded(), [edit('A'), fire, edit('B'), landed({ revision: 3 })]);
		expect(state.base?.values['name']).toBe(fp('A'));
		expect(state.base?.revision).toBe(3);
		expect(pendingFields(state)).toEqual(['name']);
		expect(atRisk(state)).toBe(true);
		// …and is saved next, on the revision the save stored.
		const next = trace(state, [fire]);
		expect(ofType(next.effects, 'persist')[0]?.flight.baseRevision).toBe(3);
		// Acknowledged, nothing is at risk and the status says so.
		const done = trace(next.state, [landed({ revision: 4 })]).state;
		expect(atRisk(done)).toBe(false);
		expect(saveStatus(done)).toBe('saved');
	});

	it('is clean again when an edit is undone back to what the server holds', () => {
		const { state } = trace(loaded(), [edit('A'), edit('Welcome')]);
		expect(isDirty(state)).toBe(false);
		expect(atRisk(state)).toBe(false);
		// The armed save finds nothing to send: no write at all.
		expect(ofType(trace(state, [fire]).effects, 'persist')).toEqual([]);
	});

	it('lets a save that started before another entity was loaded cover nothing of it', () => {
		const { state } = trace(loaded(), [
			edit('A'),
			fire,
			{ type: 'hydrated', revision: 9, values: doc('Other email'), fresh: true },
			edit('Other, edited'),
			landed({ revision: 3 }),
		]);
		expect(state.base).toEqual({ revision: 9, values: doc('Other email') });
		expect(pendingFields(state)).toEqual(['name']);
		// Nor does its refusal open a conflict on it.
		const refusedOld = trace(loaded(), [
			edit('A'),
			fire,
			{ type: 'hydrated', revision: 9, values: doc('Other email'), fresh: true },
			refused(10),
		]);
		expect(refusedOld.state.conflict).toBeNull();
		expect(refusedOld.state.failure).toBeNull();
	});

	it.each([
		['the echo before the acknowledgement', true],
		['the acknowledgement before the echo', false],
	])('keeps what is being typed when its own normalized save comes back (%s)', (_, echoFirst) => {
		const echo: DraftEvent = { type: 'observed', revision: 3 };
		const { state, effects } = trace(loaded(), [
			edit('Hello there '),
			fire,
			...(echoFirst ? [echo, landed({ revision: 3 })] : [landed({ revision: 3 }), echo]),
		]);
		expect(ofType(effects, 'hydrate')).toEqual([]);
		expect(state.values['name']).toBe(fp('Hello there '));
		expect(isDirty(state)).toBe(false);
		expect(state.base?.revision).toBe(3);
	});

	it("follows someone else's write while clean, and never while dirty", () => {
		const clean = trace(loaded(), [{ type: 'observed', revision: 5 }]);
		expect(ofType(clean.effects, 'hydrate')).toHaveLength(1);
		const dirty = trace(loaded(), [edit('Mine'), { type: 'observed', revision: 5 }]);
		expect(ofType(dirty.effects, 'hydrate')).toEqual([]);
		// A query emission is not an acknowledgement: the edit stays at risk.
		expect(atRisk(dirty.state)).toBe(true);
		// Open text counts as unsaved work too.
		const typing = trace(loaded(), [
			{ type: 'inline', open: true },
			{ type: 'observed', revision: 5 },
		]);
		expect(ofType(typing.effects, 'hydrate')).toEqual([]);
		expect(atRisk(typing.state)).toBe(true);
		// …and once it closes with nothing committed, the editor catches up.
		expect(
			ofType(trace(typing.state, [{ type: 'inline', open: false }]).effects, 'hydrate')
		).toHaveLength(1);
	});

	it('waits for an edit, a retry or the backend coming back after a failure', () => {
		const failedSave = trace(loaded(), [edit('A'), fire, refused()]);
		expect(saveStatus(failedSave.state)).toBe('error');
		expect(atRisk(failedSave.state)).toBe(true);
		expect(failedSave.state.saveTimer).toBeNull();
		const retried = trace(failedSave.state, [{ type: 'retry' }, fire]);
		expect(ofType(retried.effects, 'persist')).toHaveLength(1);
		const reconnect = trace(failedSave.state, [
			{ type: 'online', online: false },
			{ type: 'online', online: true },
			fire,
		]);
		expect(ofType(reconnect.effects, 'persist')).toHaveLength(1);
	});

	it('says offline, not saved, while the backend is away', () => {
		const { state } = trace(loaded(), [{ type: 'online', online: false }, edit('A'), fire]);
		expect(saveStatus(state)).toBe('offline');
		expect(atRisk(state)).toBe(true);
	});
});

describe('draftSession: the revision a draft is built on', () => {
	it('keeps the base an edit was made on when a newer row arrives, in its save', () => {
		const { state, effects } = trace(loaded(2), [
			edit('Mine'),
			{ type: 'observed', revision: 3 },
			fire,
			refused(3),
		]);
		expect(ofType(effects, 'persist')[0]?.flight.baseRevision).toBe(2);
		expect(state.conflict).toEqual({ revision: 3, mustReload: false, open: true });
		// A conflict freezes background saving; a dismissed one too, until the next edit.
		expect(canAutosave(state)).toBe(false);
		const dismissed = trace(state, [{ type: 'conflict-dismiss' }, fire]);
		expect(ofType(dismissed.effects, 'persist')).toEqual([]);
		// Only "keep my version" builds the draft on revision 3.
		const kept = trace(state, [
			{ type: 'rebased', revision: 3, base: doc('Theirs'), values: doc('Mine') },
			fire,
		]);
		expect(ofType(kept.effects, 'persist')[0]?.flight.baseRevision).toBe(3);
	});
});

describe('draftSession: leaving', () => {
	it('asks while the server does not hold an edit, and lets go once it does', () => {
		const unsaved = trace(loaded(), [edit('A'), request(1), ready(1)]);
		expect(verdictsOf(unsaved.effects)).toEqual([[1, false]]);
		expect(unsaved.state.leave?.phase).toBe('choosing');
		// A save on its way is not enough either.
		const sending = trace(loaded(), [edit('A'), fire, request(1), ready(1)]);
		expect(verdictsOf(sending.effects)).toEqual([[1, false]]);
		const saved = trace(loaded(), [edit('A'), fire, landed({ revision: 3 }), request(1), ready(1)]);
		expect(verdictsOf(saved.effects)).toEqual([[1, true]]);
	});

	it('holds background saves from the request on', () => {
		const { effects } = trace(loaded(), [edit('A'), request(1), fire, ready(1), fire]);
		expect(ofType(effects, 'persist')).toEqual([]);
	});

	it('decides after open text was committed, never before', () => {
		const { state, effects } = trace(loaded(), [
			{ type: 'inline', open: true },
			request(1),
			edit('Typed text'),
			{ type: 'inline', open: false },
			ready(1),
		]);
		expect(ofType(effects, 'prepare-leave')).toHaveLength(1);
		expect(verdictsOf(effects)).toEqual([[1, false]]);
		expect(atRisk(state)).toBe(true);
	});

	it("lets the prompt's Save go only when nothing is lost and nothing was edited meanwhile", () => {
		const choosing = trace(loaded(), [
			edit('A'),
			request(1),
			ready(1),
			{ type: 'leave-save', id: 1 },
		]).state;
		expect(ofType(trace(choosing, [{ type: 'leave-save', id: 1 }]).effects, 'flush-leave')).toEqual(
			[]
		);
		const edited = trace(choosing, [save(), edit('AB'), { type: 'leave-saved', id: 1, ok: true }]);
		expect(ofType(edited.effects, 'settled')).toEqual([
			{ type: 'settled', id: 1, destination: null, refused: true },
		]);
		const failedSave = trace(choosing, [{ type: 'leave-saved', id: 1, ok: false }]);
		expect(failedSave.state.leave?.phase).toBe('choosing');
		// A flush that reported done while the server still lacks the edit does not let go.
		const notHeld = trace(choosing, [{ type: 'leave-saved', id: 1, ok: true }]);
		expect(ofType(notHeld.effects, 'settled')[0]?.destination).toBeNull();
		const done = trace(choosing, [
			save(),
			landed({ revision: 3 }),
			{ type: 'leave-saved', id: 1, ok: true },
		]);
		expect(ofType(done.effects, 'settled')).toEqual([
			{ type: 'settled', id: 1, destination: '/elsewhere' },
		]);
		// The navigation it lets go passes the guard once…
		expect(verdictsOf(trace(done.state, [request(2)]).effects)).toEqual([[2, true]]);
		// …unless something came up meanwhile that would be lost: then it asks again.
		const reopened = trace(done.state, [{ type: 'inline', open: true }, request(2), ready(2)]);
		expect(verdictsOf(reopened.effects)).toEqual([[2, false]]);

		function save(): Step {
			return { type: 'save-now' };
		}
	});

	it('lets only the current decision act', () => {
		const first = trace(loaded(), [edit('A'), request(1, '/a')]).state;
		// A newer request retires the older one before it was prepared.
		const newer = trace(first, [request(2, '/b'), ready(1)]);
		expect(verdictsOf(newer.effects)).toEqual([[1, false]]);
		expect(newer.state.leave?.destination).toBe('/b');
		// Stay while preparing, and closing, settle it too.
		expect(verdictsOf(trace(first, [{ type: 'leave-cancel' }]).effects)).toEqual([[1, false]]);
		expect(verdictsOf(trace(first, [{ type: 'close' }]).effects)).toEqual([[1, false]]);
		// A Save still running when the person stays does not navigate when it lands.
		const saving = trace(loaded(), [
			edit('A'),
			request(1),
			ready(1),
			{ type: 'leave-save', id: 1 },
			{ type: 'leave-cancel' },
			{ type: 'leave-saved', id: 1, ok: true },
		]);
		expect(ofType(saving.effects, 'settled').map((e) => e.destination)).toEqual([null]);
	});
});

describe('draftSession: Discard', () => {
	it('is terminal for what it discarded: nothing is sent, also on closing', () => {
		const { state, effects } = trace(loaded(), [
			edit('Discarded'),
			request(1),
			ready(1),
			{ type: 'leave-discard', id: 1 },
			fire,
			{ type: 'close' },
		]);
		expect(ofType(effects, 'persist')).toEqual([]);
		expect(ofType(effects, 'settled')[0]?.destination).toBe('/elsewhere');
		expect(atRisk(state)).toBe(false);
	});

	it('lets a save already sent land without starting anything again', () => {
		const { effects } = trace(loaded(), [
			edit('A'),
			fire,
			{ type: 'discard' },
			landed({ revision: 3 }),
			{ type: 'online', online: false },
			{ type: 'online', online: true },
			{ type: 'close' },
		]);
		expect(ofType(effects, 'persist')).toHaveLength(1);
		expect(ofType(effects, 'timer')).toHaveLength(1);
	});

	it('saves again after the next edit', () => {
		const { effects } = trace(loaded(), [{ type: 'discard' }, edit('Again'), fire]);
		expect(ofType(effects, 'persist')).toHaveLength(1);
	});
});

describe('draftSession: live co-editing', () => {
	const session = (over: Partial<DraftLive> = {}): DraftEvent => ({
		type: 'live',
		live: { sessionId: 's1', base: 2, sharedPending: false, unsent: false, alone: false, ...over },
	});
	const live = (over: Partial<DraftLive> = {}) =>
		trace(createDraftSession(), [{ type: 'enabled', enabled: true }, session(over)]).state;

	it("counts this tab's edit at once, and leaves others' edits to their tab in the background", () => {
		const own = trace(live(), [{ type: 'live-edit' }]);
		expect(atRisk(own.state)).toBe(true);
		expect(own.state.values[OWN_EDITS]).toBe('1');
		const theirs = trace(live(), [session({ sharedPending: true }), fire]);
		expect(ofType(theirs.effects, 'persist')).toEqual([]);
		// Not saved, though: the status says so, and leaving asks.
		expect(saveStatus(theirs.state)).toBe('unsaved');
		expect(atRisk(theirs.state)).toBe(true);
		// Nobody else left to write them: this tab does.
		const left = trace(live({ alone: true }), [
			session({ sharedPending: true, alone: true }),
			fire,
		]);
		expect(ofType(left.effects, 'persist')).toHaveLength(1);
	});

	it("writes everyone's edits on an explicit save, and covers them once the session reports them written", () => {
		const saving = trace(live(), [session({ sharedPending: true }), { type: 'save-now' }]);
		expect(ofType(saving.effects, 'persist')).toHaveLength(1);
		const written = trace(saving.state, [landed()]).state;
		// The save landed, but the session still reports unwritten edits: not yet.
		expect(atRisk(written)).toBe(true);
		expect(serverHolds(trace(written, [session()]).state)).toBe(true);
	});

	it('covers only the own edits a save started with', () => {
		const { state } = trace(live(), [{ type: 'live-edit' }, fire, { type: 'live-edit' }, landed()]);
		expect(atRisk(state)).toBe(true);
		expect(state.base?.values[OWN_EDITS]).toBe('1');
	});

	it('keeps an edit the session has not taken at risk, whatever the own-edit count says', () => {
		const { state } = trace(live(), [
			{ type: 'live-edit' },
			fire,
			landed(),
			session({ unsent: true }),
		]);
		expect(pendingFields(state)).toEqual([]);
		expect(atRisk(state)).toBe(true);
		expect(saveStatus(state)).not.toBe('saved');
		// An explicit save goes for it.
		expect(ofType(trace(state, [{ type: 'save-now' }]).effects, 'persist')).toHaveLength(1);
	});

	it('never resets the shared session when leaving: Discard drops only what was not sent', () => {
		const { effects } = trace(live({ alone: true }), [
			{ type: 'live-edit' },
			request(1),
			ready(1),
			{ type: 'leave-discard', id: 1 },
			{ type: 'close' },
		]);
		expect(ofType(effects, 'drop-unsent')).toHaveLength(1);
		expect(ofType(effects, 'reload')).toEqual([]);
	});

	it("retries a failed explicit save of others' edits as an explicit save", () => {
		const failed = trace(live(), [
			session({ sharedPending: true }),
			{ type: 'save-now' },
			refused(),
		]);
		expect(saveStatus(failed.state)).toBe('error');
		const retried = trace(failed.state, [{ type: 'retry' }]);
		expect(ofType(retried.effects, 'persist')).toHaveLength(1);
	});

	it('names "keep my version" in its next save', () => {
		const { state } = trace(live(), [{ type: 'live-edit' }, fire, refused(7)]);
		const kept = trace(state, [{ type: 'rebased', revision: 7, base: {}, values: {} }, fire]);
		expect(ofType(kept.effects, 'persist')[0]?.flight.baseRevision).toBe(7);
	});
});

describe('draftSession: final actions and closing', () => {
	it('holds background saves during a final action, which saves explicitly', () => {
		const { effects } = trace(loaded(), [
			edit('A'),
			{ type: 'action-begin', id: 1 },
			fire,
			{ type: 'save-now' },
			landed({ revision: 3 }),
			edit('AB'),
			fire,
			{ type: 'action-end', id: 1 },
			fire,
		]);
		expect(ofType(effects, 'persist').map((p) => p.flight.values['name'])).toEqual([
			fp('A'),
			fp('AB'),
		]);
	});

	it('lets a final action dispatch only while the editor shows what the server holds', () => {
		const begun = trace(loaded(), [
			edit('Spring sale'),
			{ type: 'action-begin', id: 1 },
			{ type: 'save-now' },
		]).state;
		// Its save is on the way: not yet.
		expect(actionCurrent(begun, 1)).toBe(false);
		const saved = trace(begun, [landed({ revision: 3 })]).state;
		expect(actionCurrent(saved, 1)).toBe(true);
		expect(actionCurrent(saved, 2)).toBe(false);
		// Edited after its save, or text open: it must not dispatch.
		expect(actionCurrent(trace(saved, [edit('Spring sale!')]).state, 1)).toBe(false);
		expect(actionCurrent(trace(saved, [{ type: 'inline', open: true }]).state, 1)).toBe(false);
	});

	it('starts nothing when it closes, also with edits pending', () => {
		const { effects } = trace(loaded(), [edit('A'), { type: 'close' }, { type: 'close' }, fire]);
		expect(ofType(effects, 'persist')).toEqual([]);
	});

	it('enumerates every short ordering of edit, query, acknowledgement, leave and close', () => {
		// Table-driven: each permutation of these events from one edited state,
		// with the step invariants checked after every event.
		const moves: Step[] = [
			{ type: 'observed', revision: 5 },
			edit('B'),
			(s) => (s.flight ? landed({ revision: 3 })(s) : { type: 'save-now' }),
			request(9),
			(s) => ready(s.leave?.id ?? 9),
			{ type: 'close' },
		];
		const permutations = (items: number[]): number[][] =>
			items.length <= 1
				? [items]
				: items.flatMap((item, i) =>
						permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
							item,
							...rest,
						])
					);
		const start = trace(loaded(), [edit('A'), fire]).state;
		for (const order of permutations([0, 1, 2, 3, 4, 5])) {
			const { state, effects } = trace(
				start,
				order.map((i) => moves[i]!)
			);
			// Whatever the order, the leave request was answered and no decision outlives closing.
			expect(state.leave).toBeNull();
			expect(verdictsOf(effects)).toHaveLength(1);
		}
	});
});
