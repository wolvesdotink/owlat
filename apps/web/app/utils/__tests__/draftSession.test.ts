/**
 * A draft editor's session (`draftSession.ts`), as traces of events. After
 * every event the trace checks what must always hold (`checkStep`), not only
 * where it ends: no save goes out while a leave is decided or after Discard,
 * a cleanup only ever names copies this editor wrote, nothing is put into the
 * editor without Restore, and each decision settles once. Pure: no timers,
 * no storage, no Vue.
 */
import { describe, expect, it } from 'vitest';
import {
	OWN_EDITS,
	createDraftSession,
	transition,
	type DraftCandidate,
	type DraftEffect,
	type DraftEvent,
	type DraftSessionState,
	type Fingerprints,
} from '../draftSession';
import {
	actionCurrent,
	atRisk,
	canAutosave,
	deviceCovers,
	isDirty,
	onDevice,
	pendingFields,
	saveStatus,
} from '../draftSessionSelectors';

const WRITER = 'tab-a.1';

type Step = DraftEvent | ((s: DraftSessionState) => DraftEvent);

/** Every invariant that holds after any event, whatever the trace. */
function checkStep(
	before: DraftSessionState,
	event: DraftEvent,
	after: DraftSessionState,
	effects: DraftEffect[]
) {
	const persisted = effects.filter((effect) => effect.type === 'persist');
	// A choice precedes any new dispatch: only an explicit save or closing sends while one is open.
	if (before.leave !== null && event.type !== 'save-now' && event.type !== 'close') {
		expect(persisted).toEqual([]);
	}
	// Discarded work is never sent again.
	if (after.discarded) expect(persisted).toEqual([]);
	// One save at a time.
	if (before.flight !== null) expect(persisted).toEqual([]);
	// A cleanup of this editor's own copy only names copies it wrote and has not settled as gone.
	const ownTokens = new Set([
		...(before.onDisk ? [before.onDisk.token] : []),
		...before.writes.map((write) => write.token),
		...after.writes.map((write) => write.token),
	]);
	for (const effect of effects) {
		if (effect.type === 'remove-copies' && effect.key === null) {
			for (const token of effect.tokens) expect(ownTokens.has(token)).toBe(true);
		}
		// A copy is only put into the editor because Restore was chosen.
		if (effect.type === 'apply-copy') expect(event.type).toBe('recovery-restore');
		// A closed editor starts nothing new.
		if (before.closed)
			expect(['persist', 'write-copy', 'apply-copy', 'hydrate']).not.toContain(effect.type);
	}
	// What the device holds is a write this editor issued.
	if (after.onDisk && after.onDisk !== before.onDisk) {
		expect(before.writes.map((write) => write.token)).toContain(after.onDisk.token);
	}
	// The base only moves through a hydration, an acknowledgement, a rebase or a completed action.
	if (after.base !== before.base && before.base !== null && after.base !== null) {
		expect([
			'hydrated',
			'transfer',
			'rebaseline',
			'observed',
			'saved',
			'rebased',
			'action-end',
			'reload',
			'live',
		]).toContain(event.type);
	}
	// Leaving would lose exactly what is neither saved nor on the device (or volatile, or being typed).
	if (after.enabled && !after.closed && !after.discarded && pendingFields(after).length > 0) {
		expect(atRisk(after)).toBe(!(after.persistent && deviceCovers(after)));
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
const doc = (name: string, extra: Record<string, unknown> = {}): Fingerprints => ({
	name: fp(name),
	...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, fp(v)])),
});

/** A loaded classic draft at `revision`, autosave on, device storage working. */
function loaded(revision: number | null = 2, values = doc('Welcome'), config = {}) {
	return trace(createDraftSession({ writer: WRITER, ...config }), [
		{ type: 'enabled', enabled: true },
		{ type: 'hydrated', revision, values, fresh: false },
	]).state;
}

const edit = (name: string, extra: Record<string, unknown> = {}): DraftEvent => ({
	type: 'edit',
	values: doc(name, extra),
});
const fire =
	(name: 'save' | 'mirror' | 'leave') =>
	(s: DraftSessionState): DraftEvent => ({
		type: 'timer',
		name,
		id:
			(name === 'save' ? s.saveTimer : name === 'mirror' ? s.mirrorTimer : s.leave?.deadline) ?? -1,
	});
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
const lastWrite = (s: DraftSessionState) => s.writes.at(-1)!.token;
const committed = (s: DraftSessionState): DraftEvent => ({
	type: 'copy-committed',
	token: lastWrite(s),
});
const failed = (s: DraftSessionState): DraftEvent => ({ type: 'copy-failed', token: lastWrite(s) });
const ofType = <T extends DraftEffect['type']>(effects: DraftEffect[], type: T) =>
	effects.filter((effect): effect is Extract<DraftEffect, { type: T }> => effect.type === type);

describe('draftSession: editing and saving', () => {
	it('counts an edit as pending and at risk from the moment it is made', () => {
		const { state, effects } = trace(loaded(), [edit('Hello')]);
		expect(state.localRevision).toBe(1);
		expect(atRisk(state)).toBe(true);
		expect(ofType(effects, 'persist')).toEqual([]);
		expect(ofType(effects, 'timer').map((t) => t.name)).toEqual(['save', 'mirror']);
	});

	it('saves the latest draft once the pause runs out, one save at a time', () => {
		const { state, effects } = trace(loaded(), [edit('A'), edit('AB'), fire('save')]);
		const [flight] = ofType(effects, 'persist');
		expect(flight?.flight.values['name']).toBe(fp('AB'));
		expect(flight?.flight.baseRevision).toBe(2);
		expect(state.flight).not.toBeNull();
	});

	it('acknowledges only what a save carried: a later edit stays pending and at risk', () => {
		const { state } = trace(loaded(), [
			edit('A'),
			fire('save'),
			edit('B'),
			landed({ revision: 3 }),
		]);
		expect(state.base?.values['name']).toBe(fp('A'));
		expect(state.base?.revision).toBe(3);
		expect(pendingFields(state)).toEqual(['name']);
		expect(atRisk(state)).toBe(true);
		// …and is saved next, on the revision the save stored.
		const next = trace(state, [fire('save')]);
		expect(ofType(next.effects, 'persist')[0]?.flight.baseRevision).toBe(3);
	});

	it('is clean again when an edit is undone back to what the server holds', () => {
		const { state } = trace(loaded(), [edit('A'), edit('Welcome')]);
		expect(isDirty(state)).toBe(false);
		expect(atRisk(state)).toBe(false);
		// The armed save finds nothing to send: no write at all.
		expect(ofType(trace(state, [fire('save')]).effects, 'persist')).toEqual([]);
	});

	it('lets a save that started before another entity was loaded cover nothing of it', () => {
		const { state } = trace(loaded(), [
			edit('A'),
			fire('save'),
			{ type: 'hydrated', revision: 9, values: doc('Other email'), fresh: true },
			edit('Other, edited'),
			landed({ revision: 3 }),
		]);
		expect(state.base).toEqual({ revision: 9, values: doc('Other email') });
		expect(pendingFields(state)).toEqual(['name']);
		// Nor does its refusal open a conflict on it.
		const refusedOld = trace(loaded(), [
			edit('A'),
			fire('save'),
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
			fire('save'),
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
		// Open text counts as unsaved work too.
		const typing = trace(loaded(), [
			{ type: 'inline', open: true },
			{ type: 'observed', revision: 5 },
		]);
		expect(ofType(typing.effects, 'hydrate')).toEqual([]);
		// …and once it closes with nothing committed, the editor catches up.
		expect(
			ofType(trace(typing.state, [{ type: 'inline', open: false }]).effects, 'hydrate')
		).toHaveLength(1);
	});

	it('waits for an edit, a retry or the backend coming back after a failure', () => {
		const failedSave = trace(loaded(), [edit('A'), fire('save'), refused()]);
		expect(saveStatus(failedSave.state)).toBe('error');
		expect(failedSave.state.saveTimer).toBeNull();
		const retried = trace(failedSave.state, [{ type: 'retry' }, fire('save')]);
		expect(ofType(retried.effects, 'persist')).toHaveLength(1);
		const reconnect = trace(failedSave.state, [
			{ type: 'online', online: false },
			{ type: 'online', online: true },
			fire('save'),
		]);
		expect(ofType(reconnect.effects, 'persist')).toHaveLength(1);
	});
});

describe('draftSession: the revision a draft is built on', () => {
	it('keeps the base an edit was made on when a newer row arrives, in its copy and its save', () => {
		const { state, effects } = trace(loaded(2), [
			edit('Mine'),
			{ type: 'observed', revision: 3 },
			fire('mirror'),
			fire('save'),
			refused(3),
		]);
		expect(ofType(effects, 'write-copy')[0]?.write.base).toBe(2);
		expect(ofType(effects, 'persist')[0]?.flight.baseRevision).toBe(2);
		expect(state.conflict).toEqual({ revision: 3, mustReload: false, open: true });
		// A conflict freezes background saving; a dismissed one too, until the next edit.
		expect(canAutosave(state)).toBe(false);
		const dismissed = trace(state, [{ type: 'conflict-dismiss' }, fire('save')]);
		expect(ofType(dismissed.effects, 'persist')).toEqual([]);
		// Only "keep my version" builds the draft on revision 3.
		const kept = trace(state, [
			{ type: 'rebased', revision: 3, base: doc('Theirs'), values: doc('Mine') },
			fire('save'),
		]);
		expect(ofType(kept.effects, 'persist')[0]?.flight.baseRevision).toBe(3);
	});

	it('moves a campaign base on only when nobody else wrote between', () => {
		const campaign = () => loaded(100, doc('Spring'));
		const own = trace(campaign(), [
			edit('Spring sale'),
			fire('save'),
			landed({ lineage: { from: 100, to: 150 } }),
		]);
		expect(own.state.base?.revision).toBe(150);
		const theirs = trace(campaign(), [
			edit('Spring sale'),
			fire('save'),
			landed({ lineage: { from: 200, to: 300 } }),
		]);
		// Covered (the server holds it), but still built on what was loaded.
		expect(theirs.state.base?.revision).toBe(100);
		expect(isDirty(theirs.state)).toBe(false);
	});
});

const candidate = (over: Partial<DraftCandidate> = {}): DraftCandidate => ({
	key: 'scope:tab-old.1',
	token: 'tab-old.1#4',
	liveness: 'closed',
	savedAt: 500,
	base: 2,
	matches: false,
	...over,
});
const read =
	(candidates: DraftCandidate[]) =>
	(s: DraftSessionState): DraftEvent => ({
		type: 'recovery-read',
		request: s.recovery.request,
		candidates,
	});

describe('draftSession: copies left on the device', () => {
	it('only offers a copy, also one built on the revision the server holds', () => {
		const { state, effects } = trace(loaded(2), [
			{ type: 'recovery-start', scope: 'scope:' },
			read([candidate({ base: 2 })]),
		]);
		expect(ofType(effects, 'read-copies')).toHaveLength(1);
		expect(ofType(effects, 'apply-copy')).toEqual([]);
		expect(state.offer?.candidate.token).toBe('tab-old.1#4');
		expect(isDirty(state)).toBe(false);
	});

	it.each<[string, Step[]]>([
		['typing during the read', [edit('Typed meanwhile')]],
		['open text during the read', [{ type: 'inline', open: true }]],
		['someone else saving during the read', [{ type: 'observed', revision: 3 }]],
	])('still only offers after %s', (_, during) => {
		const { state, effects } = trace(loaded(2), [
			{ type: 'recovery-start', scope: 'scope:' },
			...during,
			read([candidate()]),
		]);
		expect(ofType(effects, 'apply-copy')).toEqual([]);
		expect(state.offer).not.toBeNull();
	});

	it.each<[string, Step[]]>([
		['another entity', [{ type: 'hydrated', revision: 7, values: doc('Other'), fresh: true }]],
		['Discard', [{ type: 'discard' }]],
		['the editor closing', [{ type: 'close' }]],
	])('drops a read that finishes after %s', (_, during) => {
		const started = trace(loaded(2), [{ type: 'recovery-start', scope: 'scope:' }]).state;
		const { state, effects } = trace(started, [
			...during,
			{ type: 'recovery-read', request: started.recovery.request, candidates: [candidate()] },
			{ type: 'recovery-restore' },
		]);
		expect(state.offer).toBeNull();
		expect(ofType(effects, 'apply-copy')).toEqual([]);
	});

	it('cleans up a copy saying what is shown only when its editor is known to be closed', () => {
		const { state, effects } = trace(loaded(), [
			{ type: 'recovery-start', scope: 'scope:' },
			read([
				candidate({ key: 'scope:open.1', token: 'o', liveness: 'open' }),
				candidate({ key: 'scope:closed.1', token: 'c', matches: true }),
				candidate({ key: 'scope:unknown.1', token: 'u', liveness: 'unknown', matches: true }),
			]),
		]);
		expect(ofType(effects, 'remove-copies')).toEqual([
			{ type: 'remove-copies', key: 'scope:closed.1', tokens: ['c'] },
		]);
		expect(state.offer).toBeNull();
	});

	it('asks once more before Restore replaces an edit made after the offer', () => {
		const offered = trace(loaded(), [
			{ type: 'recovery-start', scope: 'scope:' },
			read([candidate()]),
		]);
		const first = trace(offered.state, [edit('Newer typing'), { type: 'recovery-restore' }]);
		expect(ofType(first.effects, 'apply-copy')).toEqual([]);
		expect(first.state.offer?.confirm).toBe(true);
		const second = trace(first.state, [{ type: 'recovery-restore' }]);
		expect(ofType(second.effects, 'apply-copy')).toHaveLength(1);
	});

	it('restores as an edit on the confirmed base, and retires the source only once its snapshot is kept', () => {
		const restored = trace(loaded(2), [
			{ type: 'recovery-start', scope: 'scope:' },
			read([candidate()]),
			{ type: 'recovery-restore' },
			edit('From the copy'),
			(s) => ({ type: 'recovery-applied', request: s.recovery.request }),
		]);
		const write = ofType(restored.effects, 'write-copy').at(-1)!.write;
		expect(write.values['name']).toBe(fp('From the copy'));
		// A later server write still makes its save a conflict: the base did not move.
		expect(restored.state.base?.revision).toBe(2);
		const sourceRemoved = (effects: DraftEffect[]) =>
			ofType(effects, 'remove-copies').some((effect) => effect.key === 'scope:tab-old.1');

		// The new copy failing keeps the source.
		expect(sourceRemoved(trace(restored.state, [failed]).effects)).toBe(false);
		// Edited again while the adopted copy is written: the source receipt covers
		// only the adopted snapshot, and the later edit stays uncovered.
		const adopted = trace(restored.state, [edit('From the copy, edited'), committed]);
		expect(sourceRemoved(adopted.effects)).toBe(true);
		expect(deviceCovers(adopted.state)).toBe(false);
		expect(atRisk(adopted.state)).toBe(true);
		// A save of exactly the adopted snapshot also proves it kept.
		const savedAdoption = trace(restored.state, [failed, fire('save'), landed({ revision: 3 })]);
		expect(sourceRemoved(savedAdoption.effects)).toBe(true);
	});

	it('never deletes a source whose editor may still be open', () => {
		const { effects } = trace(loaded(), [
			{ type: 'recovery-start', scope: 'scope:' },
			read([candidate({ liveness: 'unknown' })]),
			{ type: 'recovery-restore' },
			edit('From the copy'),
			(s) => ({ type: 'recovery-applied', request: s.recovery.request }),
			committed,
			{ type: 'recovery-discard' },
		]);
		expect(ofType(effects, 'remove-copies').some((e) => e.key === 'scope:tab-old.1')).toBe(false);
	});

	const sourceGone = (effects: DraftEffect[]) =>
		ofType(effects, 'remove-copies').some((effect) => effect.key === 'scope:tab-old.1');

	it('keeps the source while a restored field is held nowhere else, whatever a save of the others did', () => {
		// A campaign: the copy restores a name and an unfinished audience choice.
		const restored = trace(loaded(100, doc('Original', { audience: 'segment:old' })), [
			{ type: 'recovery-start', scope: 'scope:' },
			read([candidate({ base: 100 })]),
			{ type: 'recovery-restore' },
			{
				type: 'edit',
				values: doc('Restored', { audience: 'topic:none picked' }),
				deviceOnly: ['audience'],
			},
			(s) => ({ type: 'recovery-applied', request: s.recovery.request }),
		]);
		// Its own copy of the snapshot fails; then the name is saved, without the audience.
		const saved = trace(restored.state, [
			failed,
			fire('save'),
			(s) => {
				expect(s.flight?.included).toEqual(['name']);
				return landed({ lineage: { from: 100, to: 150 } })(s);
			},
		]);
		expect(sourceGone(saved.effects)).toBe(false);
		expect(saved.state.adopting).not.toBeNull();
		// Once a copy holding the audience commits, nothing depends on the source.
		const kept = trace(saved.state, [fire('mirror'), committed]);
		expect(sourceGone(kept.effects)).toBe(true);
	});

	it('takes over a copy saying what is shown while nothing durable holds it, and lets it go once kept', () => {
		// Typed while the read ran: the editor shows what the copy holds, but the
		// server still has the original and this editor has no committed copy.
		const matching = candidate({ matches: true });
		const read1 = trace(loaded(2), [
			{ type: 'recovery-start', scope: 'scope:' },
			edit('Restored'),
			read([matching]),
		]);
		expect(sourceGone(read1.effects)).toBe(false);
		expect(read1.state.offer).toBeNull();
		expect(read1.state.adopting?.source.token).toBe(matching.token);
		// Its own copy is written at once; the source goes when it commits.
		expect(ofType(read1.effects, 'write-copy')).toHaveLength(1);
		expect(sourceGone(trace(read1.state, [failed]).effects)).toBe(false);
		expect(sourceGone(trace(read1.state, [committed]).effects)).toBe(true);
		// Or when a save of it lands.
		const saved = trace(read1.state, [failed, fire('save'), landed({ revision: 3 })]);
		expect(sourceGone(saved.effects)).toBe(true);
		// Without device storage only the save can keep it.
		const noStorage = trace(loaded(2), [
			{ type: 'storage', persistent: false },
			{ type: 'recovery-start', scope: 'scope:' },
			edit('Restored'),
			read([matching]),
		]);
		expect(sourceGone(noStorage.effects)).toBe(false);
		expect(ofType(noStorage.effects, 'write-copy')).toEqual([]);
	});

	it('asks before Restore replaces text open in a block, then restores over it', () => {
		const offered = trace(loaded(), [
			{ type: 'recovery-start', scope: 'scope:' },
			read([candidate()]),
			{ type: 'inline', open: true },
		]);
		const first = trace(offered.state, [{ type: 'recovery-restore' }]);
		expect(ofType(first.effects, 'apply-copy')).toEqual([]);
		expect(first.state.offer?.confirm).toBe(true);
		const second = trace(first.state, [{ type: 'recovery-restore' }]);
		expect(ofType(second.effects, 'apply-copy')).toHaveLength(1);
		// An edit made after that confirmation asks again.
		const later = trace(first.state, [
			edit('Typed after the question'),
			{ type: 'recovery-restore' },
		]);
		expect(ofType(later.effects, 'apply-copy')).toEqual([]);
		expect(later.state.offer?.confirm).toBe(true);
	});
});

describe('draftSession: the device copy', () => {
	it('counts only a committed copy of the current values as on the device', () => {
		const writing = trace(loaded(), [edit('A'), fire('mirror')]);
		expect(onDevice(writing.state)).toBe(false);
		expect(atRisk(writing.state)).toBe(true);
		const kept = trace(writing.state, [committed]);
		expect(onDevice(kept.state)).toBe(true);
		expect(atRisk(kept.state)).toBe(false);
		// A newer edit is not on the device until its own copy commits.
		expect(atRisk(trace(kept.state, [edit('AB')]).state)).toBe(true);
	});

	it('lets an older write landing late neither cover nor clean up a newer one', () => {
		const { state } = trace(loaded(), [edit('A'), fire('mirror'), edit('B'), fire('mirror')]);
		const [a, b] = state.writes;
		const afterA = trace(state, [{ type: 'copy-committed', token: a!.token }]);
		expect(deviceCovers(afterA.state)).toBe(false);
		const afterB = trace(afterA.state, [{ type: 'copy-committed', token: b!.token }]);
		expect(deviceCovers(afterB.state)).toBe(true);
		// A commit of a write already settled (or never issued) changes nothing.
		const stale = trace(afterB.state, [{ type: 'copy-committed', token: a!.token }]);
		expect(stale.state.onDisk?.token).toBe(b!.token);
		// Writes carry a sequence that grows, whatever the clock says.
		expect(b!.seq).toBeGreaterThan(a!.seq);
	});

	it('drops the copy once a save covers it, and keeps it while something is left', () => {
		const saved = trace(loaded(), [
			edit('A'),
			fire('mirror'),
			committed,
			fire('save'),
			landed({ revision: 3 }),
		]);
		const removed = ofType(saved.effects, 'remove-copies');
		expect(removed.at(-1)?.key).toBeNull();
		expect(saved.state.onDisk).toBeNull();
		// An edit made during the save keeps its copy.
		const during = trace(loaded(), [
			edit('A'),
			fire('save'),
			edit('AB'),
			fire('mirror'),
			committed,
			landed({ revision: 3 }),
		]);
		expect(during.state.onDisk).not.toBeNull();
		expect(onDevice(during.state)).toBe(true);
	});

	it('keeps an incomplete choice at risk until its copy commits, whatever a save did', () => {
		const start = loaded(100, doc('Spring', { audience: ['topic', 'tp_1', null] }));
		const choice: DraftEvent = {
			type: 'edit',
			values: doc('Spring', { audience: ['segment', 'tp_1', null] }),
			deviceOnly: ['audience'],
		};
		// Nothing a save could carry: no write at all, and no coverage from one.
		const noWrite = trace(start, [choice, fire('save')]);
		expect(ofType(noWrite.effects, 'persist')).toEqual([]);
		expect(atRisk(noWrite.state)).toBe(true);
		// A save of other sections covers those only.
		const other = trace(start, [
			choice,
			{ type: 'edit', values: doc('Spring sale') },
			fire('save'),
			(s) => {
				expect(s.flight?.included).toEqual(['name']);
				return landed({ lineage: { from: 100, to: 150 } })(s);
			},
		]);
		expect(pendingFields(other.state)).toEqual(['audience']);
		expect(atRisk(other.state)).toBe(true);
		const failedCopy = trace(other.state, [fire('mirror'), failed]);
		expect(atRisk(failedCopy.state)).toBe(true);
		expect(saveStatus(failedCopy.state)).toBe('unkept');
		const keptCopy = trace(other.state, [fire('mirror'), committed]);
		expect(atRisk(keptCopy.state)).toBe(false);
	});
});

describe('draftSession: volatile choices (the campaign schedule)', () => {
	const start = () =>
		loaded(100, doc('Spring', { schedule: ['', '', 'instant'] }), { volatile: ['schedule'] });
	const pick = edit('Spring', { schedule: ['2026-12-01', '09:00', 'instant'] });

	it('keeps a schedule guarded although the draft is saved and a copy committed', () => {
		const { state, effects } = trace(start(), [pick, fire('save'), fire('mirror')]);
		// No save carries it, and the copy leaves it out.
		expect(ofType(effects, 'persist')).toEqual([]);
		expect(ofType(effects, 'write-copy')).toEqual([]);
		expect(atRisk(state)).toBe(true);
		expect(saveStatus(state)).toBe('scheduling');
		const named = trace(state, [
			edit('Spring sale', { schedule: ['2026-12-01', '09:00', 'instant'] }),
		]);
		const saved = trace(named.state, [
			fire('save'),
			landed({ lineage: { from: 100, to: 150 } }),
			fire('mirror'),
		]);
		expect(saveStatus(saved.state)).toBe('scheduling');
		expect(atRisk(saved.state)).toBe(true);
	});

	it('ends its risk only through the action that consumed it, or Discard', () => {
		const picked = trace(start(), [pick]).state;
		const refusedAction = trace(picked, [
			{ type: 'action-begin', id: 1 },
			{ type: 'action-end', id: 1, ok: false, consumed: ['schedule'] },
		]);
		expect(atRisk(refusedAction.state)).toBe(true);
		const done = trace(picked, [
			{ type: 'action-begin', id: 1 },
			{ type: 'action-end', id: 1, ok: true, consumed: ['schedule'] },
		]);
		expect(atRisk(done.state)).toBe(false);
		expect(atRisk(trace(picked, [{ type: 'discard' }]).state)).toBe(false);
	});

	it('covers only the schedule the action began with', () => {
		const { state } = trace(start(), [
			pick,
			{ type: 'action-begin', id: 1 },
			edit('Spring', { schedule: ['2026-12-02', '09:00', 'instant'] }),
			{ type: 'action-end', id: 1, ok: true, consumed: ['schedule'] },
		]);
		expect(atRisk(state)).toBe(true);
	});
});

const request = (
	id: number,
	destination = '/elsewhere',
	kind: 'navigate' | 'open-tab' = 'navigate'
): DraftEvent => ({
	type: 'leave-requested',
	id,
	destination,
	kind,
});
const verdictsOf = (effects: DraftEffect[]) =>
	ofType(effects, 'verdict').map((effect) => [effect.id, effect.leave]);

describe('draftSession: leaving', () => {
	it('holds background saves from the request on, and lets go once the copy is kept', () => {
		const { state, effects } = trace(loaded(), [
			edit('A'),
			request(1),
			fire('save'),
			{ type: 'leave-ready', id: 1 },
		]);
		expect(ofType(effects, 'persist')).toEqual([]);
		expect(state.leave?.deadline).not.toBeNull();
		expect(ofType(effects, 'write-copy')).toHaveLength(1);
		expect(verdictsOf(trace(state, [committed]).effects)).toEqual([[1, true]]);
	});

	it('asks once the bounded wait for the copy runs out, and when nothing can keep it', () => {
		const waiting = trace(loaded(), [edit('A'), request(1), { type: 'leave-ready', id: 1 }]).state;
		const timedOut = trace(waiting, [fire('leave')]);
		expect(verdictsOf(timedOut.effects)).toEqual([[1, false]]);
		expect(timedOut.state.leave?.phase).toBe('choosing');
		const nowhere = trace(loaded(), [
			{ type: 'storage', persistent: false },
			edit('A'),
			request(1),
			{ type: 'leave-ready', id: 1 },
		]);
		expect(verdictsOf(nowhere.effects)).toEqual([[1, false]]);
	});

	it('decides after open text was committed, never before', () => {
		const { state, effects } = trace(loaded(), [
			{ type: 'inline', open: true },
			request(1),
			edit('Typed text'),
			{ type: 'inline', open: false },
			{ type: 'storage', persistent: false },
			{ type: 'leave-ready', id: 1 },
		]);
		expect(ofType(effects, 'prepare-leave')).toHaveLength(1);
		expect(verdictsOf(effects)).toEqual([[1, false]]);
		expect(atRisk(state)).toBe(true);
	});

	it("lets the prompt's Save go only when nothing is lost and nothing was edited meanwhile", () => {
		const choosing = trace(loaded(), [
			{ type: 'storage', persistent: false },
			edit('A'),
			request(1),
			{ type: 'leave-ready', id: 1 },
			{ type: 'leave-save', id: 1 },
		]).state;
		expect(ofType(trace(choosing, [{ type: 'leave-save', id: 1 }]).effects, 'flush-leave')).toEqual(
			[]
		);
		const edited = trace(choosing, [save(), edit('AB'), { type: 'leave-saved', id: 1, ok: true }]);
		expect(ofType(edited.effects, 'settled')).toEqual([
			{ type: 'settled', id: 1, destination: null, reason: 'unsaved' },
		]);
		const failedSave = trace(choosing, [{ type: 'leave-saved', id: 1, ok: false }]);
		expect(failedSave.state.leave?.phase).toBe('choosing');
		const done = trace(choosing, [
			save(),
			landed({ revision: 3 }),
			{ type: 'leave-saved', id: 1, ok: true },
		]);
		expect(ofType(done.effects, 'settled')).toEqual([
			{ type: 'settled', id: 1, destination: '/elsewhere' },
		]);
		// The navigation it lets go passes the guard once.
		expect(verdictsOf(trace(done.state, [request(2)]).effects)).toEqual([[2, true]]);

		function save(): Step {
			return { type: 'save-now' };
		}
	});

	it('lets only the current decision act', () => {
		const first = trace(loaded(), [edit('A'), request(1, '/a')]).state;
		// A newer request retires the older one before it was prepared.
		const newer = trace(first, [request(2, '/b'), { type: 'leave-ready', id: 1 }]);
		expect(verdictsOf(newer.effects)).toEqual([[1, false]]);
		expect(newer.state.leave?.destination).toBe('/b');
		// Stay while preparing, and closing, settle it too.
		expect(verdictsOf(trace(first, [{ type: 'leave-cancel' }]).effects)).toEqual([[1, false]]);
		expect(verdictsOf(trace(first, [{ type: 'close' }]).effects)).toEqual([[1, false]]);
		// A Save still running when the person stays does not navigate when it lands.
		const saving = trace(loaded(), [
			{ type: 'storage', persistent: false },
			edit('A'),
			request(1),
			{ type: 'leave-ready', id: 1 },
			{ type: 'leave-save', id: 1 },
			{ type: 'leave-cancel' },
			{ type: 'leave-saved', id: 1, ok: true },
		]);
		expect(ofType(saving.effects, 'settled').map((e) => e.destination)).toEqual([null]);
	});

	it('opens an editor in a new tab without discarding anything', () => {
		const { state, effects } = trace(loaded(), [edit('A'), request(1, '/email', 'open-tab')]);
		expect(verdictsOf(effects)).toEqual([[1, false]]);
		const opened = trace(state, [{ type: 'leave-discard', id: 1 }, fire('save')]);
		expect(opened.state.discarded).toBe(false);
		expect(ofType(opened.effects, 'settled')[0]?.destination).toBe('/email');
		expect(ofType(opened.effects, 'persist')).toHaveLength(1);
	});
});

describe('draftSession: Discard', () => {
	it('is terminal for what it discarded: nothing is sent or kept, also on closing', () => {
		const { state, effects } = trace(loaded(), [
			edit('Discarded'),
			fire('mirror'),
			request(1),
			{ type: 'leave-ready', id: 1 },
			fire('leave'),
			{ type: 'leave-discard', id: 1 },
			fire('save'),
			// The write that was on its way lands after the discard.
			{ type: 'copy-committed', token: `${WRITER}#1` },
			{ type: 'close' },
		]);
		expect(ofType(effects, 'persist')).toEqual([]);
		// The write that was on its way is deleted once it lands, by its token.
		const removed = ofType(effects, 'remove-copies').flatMap((e) => e.tokens);
		expect(removed).toContain(`${WRITER}#1`);
		expect(state.onDisk).toBeNull();
	});

	it('lets a save already sent land without starting anything again', () => {
		const { effects } = trace(loaded(), [
			edit('A'),
			fire('save'),
			{ type: 'discard' },
			landed({ revision: 3 }),
			{ type: 'online', online: false },
			{ type: 'online', online: true },
			{ type: 'close' },
		]);
		expect(ofType(effects, 'persist')).toHaveLength(1);
		expect(ofType(effects, 'timer').filter((t) => t.name === 'save')).toHaveLength(1);
	});

	it('does not let cleaning up a discarded copy remove a later edit', () => {
		const discarded = trace(loaded(), [edit('A'), fire('mirror'), { type: 'discard' }]);
		const later = trace(discarded.state, [edit('Again'), fire('mirror')]);
		const cleanup = ofType(discarded.effects, 'remove-copies')[0]!;
		expect(cleanup.tokens).not.toContain(lastWrite(later.state));
		expect(ofType(trace(later.state, [fire('save')]).effects, 'persist')).toHaveLength(1);
	});
});

describe('draftSession: live co-editing', () => {
	const live = (alone = false) =>
		trace(createDraftSession({ writer: WRITER }), [
			{ type: 'enabled', enabled: true },
			{ type: 'live', live: { sessionId: 's1', base: 2, sharedPending: false, alone } },
		]).state;

	it("counts this tab's edit at once, and leaves others' edits to them while they are here", () => {
		const own = trace(live(), [{ type: 'live-edit' }]);
		expect(atRisk(own.state)).toBe(true);
		expect(own.state.values[OWN_EDITS]).toBe('1');
		const theirs = trace(live(), [
			{ type: 'live', live: { sessionId: 's1', base: 2, sharedPending: true, alone: false } },
			fire('save'),
		]);
		expect(ofType(theirs.effects, 'persist')).toEqual([]);
		// Nobody else left to write them: this tab does.
		const left = trace(live(), [
			{ type: 'live', live: { sessionId: 's1', base: 2, sharedPending: true, alone: true } },
			fire('save'),
		]);
		expect(ofType(left.effects, 'persist')).toHaveLength(1);
	});

	it('covers only the own edits a save started with', () => {
		const { state } = trace(live(), [
			{ type: 'live-edit' },
			fire('save'),
			{ type: 'live-edit' },
			landed(),
		]);
		expect(atRisk(state)).toBe(true);
		expect(state.base?.values[OWN_EDITS]).toBe('1');
	});

	it('never resets the shared session when leaving: Discard drops only what was not sent', () => {
		const { effects } = trace(live(true), [
			{ type: 'live-edit' },
			{ type: 'storage', persistent: false },
			request(1),
			{ type: 'leave-ready', id: 1 },
			{ type: 'leave-discard', id: 1 },
			{ type: 'close' },
		]);
		expect(ofType(effects, 'drop-unsent')).toHaveLength(1);
		expect(ofType(effects, 'reload')).toEqual([]);
		expect(ofType(effects, 'send-unsent')).toEqual([]);
	});

	it('names the session base in its copy, and "keep my version" in its next save', () => {
		const { state, effects } = trace(live(), [
			{ type: 'live-edit' },
			fire('mirror'),
			fire('save'),
			refused(7),
		]);
		expect(ofType(effects, 'write-copy')[0]?.write.base).toBe(2);
		const kept = trace(state, [
			{ type: 'rebased', revision: 7, base: {}, values: {} },
			fire('save'),
		]);
		expect(ofType(kept.effects, 'persist')[0]?.flight.baseRevision).toBe(7);
	});
});

describe('draftSession: final actions and closing', () => {
	it('holds background saves during a final action, which saves explicitly', () => {
		const { effects } = trace(loaded(), [
			edit('A'),
			{ type: 'action-begin', id: 1 },
			fire('save'),
			{ type: 'save-now' },
			landed({ revision: 3 }),
			edit('AB'),
			fire('save'),
			{ type: 'action-end', id: 1, ok: true, consumed: [] },
			fire('save'),
		]);
		expect(ofType(effects, 'persist').map((p) => p.flight.values['name'])).toEqual([
			fp('A'),
			fp('AB'),
		]);
	});

	it('lets a final action dispatch only while the editor shows what the server holds', () => {
		const start = loaded(100, doc('Spring', { schedule: ['2026-12-01', '09:00', 'instant'] }), {
			volatile: ['schedule'],
		});
		const begun = trace(start, [
			edit('Spring sale', { schedule: ['2026-12-01', '09:00', 'instant'] }),
			{ type: 'action-begin', id: 1 },
			{ type: 'save-now' },
		]).state;
		const schedule = ['schedule'];
		// Its save is on the way: not yet.
		expect(actionCurrent(begun, 1, schedule)).toBe(false);
		const saved = trace(begun, [landed({ lineage: { from: 100, to: 150 } })]).state;
		expect(actionCurrent(saved, 1, schedule)).toBe(true);
		expect(actionCurrent(saved, 2, schedule)).toBe(false);
		// Edited after its save, or the schedule changed: it must not dispatch.
		const edited = trace(saved, [
			edit('Spring sale!', { schedule: ['2026-12-01', '09:00', 'instant'] }),
		]).state;
		expect(actionCurrent(edited, 1, schedule)).toBe(false);
		// A changed schedule stops only the action that takes it (Schedule, not Send).
		const moved = trace(saved, [
			edit('Spring sale', { schedule: ['2026-12-02', '09:00', 'instant'] }),
		]).state;
		expect(actionCurrent(moved, 1, schedule)).toBe(false);
		expect(actionCurrent(moved, 1)).toBe(true);
		expect(actionCurrent(trace(saved, [{ type: 'inline', open: true }]).state, 1)).toBe(false);
	});

	it('saves and keeps what is pending on the way out, once', () => {
		const { effects } = trace(loaded(), [
			edit('A'),
			{ type: 'close' },
			{ type: 'close' },
			fire('save'),
		]);
		expect(ofType(effects, 'persist')).toHaveLength(1);
		expect(ofType(effects, 'write-copy')).toHaveLength(1);
	});

	it('enumerates every short ordering of edit, query, acknowledgement, copy and leave', () => {
		// Table-driven: each permutation of these events from one edited state,
		// with the step invariants checked after every event.
		const moves: Step[] = [
			{ type: 'observed', revision: 5 },
			edit('B'),
			(s) => (s.flight ? landed({ revision: 3 })(s) : { type: 'save-now' }),
			(s) => (s.writes.length ? committed(s) : fire('mirror')(s)),
			request(9),
			(s) => ({ type: 'leave-ready', id: s.leave?.id ?? 9 }),
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
		const start = trace(loaded(), [edit('A'), fire('save'), fire('mirror')]).state;
		for (const order of permutations([0, 1, 2, 3, 4, 5])) {
			const { state } = trace(
				start,
				order.map((i) => moves[i]!)
			);
			// Whatever the order, an unsaved edit is either on the device or guarded.
			if (pendingFields(state).length > 0) expect(atRisk(state) || onDevice(state)).toBe(true);
		}
	});
});
