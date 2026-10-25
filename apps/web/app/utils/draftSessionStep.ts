/**
 * One transition of a draft editor's session (`draftSession.ts`) in the
 * making: the state so far, the effects to run, and the moves several events
 * share (arming the save timer, starting a save, deciding a leave). Split out
 * for the file-size cap.
 */

import { atRisk, canAutosave, pendingFields, saveFields } from './draftSessionSelectors';
import type { DraftEffect, DraftSessionState, Fingerprints } from './draftSessionTypes';

export const pick = (values: Fingerprints, keys: readonly string[]): Fingerprints =>
	Object.fromEntries(keys.filter((key) => key in values).map((key) => [key, values[key]!]));

/** The revision a save of the current draft must still find on the server. */
const flightBase = (s: DraftSessionState) =>
	s.keepOver ?? (s.live ? s.live.base : (s.base?.revision ?? null));

export class DraftStep {
	readonly effects: DraftEffect[] = [];

	constructor(public state: DraftSessionState) {}

	set(patch: Partial<DraftSessionState>): void {
		this.state = { ...this.state, ...patch };
	}

	emit(effect: DraftEffect): void {
		this.effects.push(effect);
	}

	/** A fresh id for a timer, flight or request. */
	id(): number {
		const value = this.state.next;
		this.set({ next: value + 1 });
		return value;
	}

	// ── Saving ──────────────────────────────────────────────────────────
	armSave(ms = this.state.debounceMs): void {
		const id = this.id();
		this.set({ saveTimer: id });
		this.emit({ type: 'timer', id, ms });
	}

	/**
	 * Saving may go on: arm a save for what waits, unless one is on its way. A
	 * failed save waits for an edit, a retry or the backend coming back.
	 */
	resume(afterFailure = false): void {
		const s = this.state;
		if (!canAutosave(s) || s.flight || s.saveTimer !== null) return;
		if (s.failure !== null && !afterFailure) return;
		if (saveFields(s).length > 0) this.armSave();
	}

	/** Freeze what a save carries now and send it. */
	startFlight(explicit = false): void {
		const s = this.state;
		const included = saveFields(s, explicit);
		if (included.length === 0) return;
		const flight = {
			id: this.id(),
			epoch: s.epoch,
			hydration: s.hydration,
			baseRevision: flightBase(s),
			values: s.values,
			included,
		};
		this.set({ flight, saveTimer: null });
		this.emit({ type: 'persist', flight });
	}

	/** An edit made here: it waits for the pause. */
	localEdit(): void {
		const s = this.state;
		const conflict = s.conflict && !s.conflict.open ? null : s.conflict;
		// A navigation a decision let go is void once there is something new to decide about.
		this.set({ localRevision: s.localRevision + 1, discarded: false, conflict, pass: null });
		if (canAutosave(this.state)) this.armSave();
	}

	/** Clean again: an emission skipped meanwhile (someone else's write) is shown now. */
	catchUp(): void {
		const s = this.state;
		if (!s.base || s.live || s.inline || s.flight || s.latest === null) return;
		if (pendingFields(s).length > 0) return;
		if (s.latest === s.ownRevision) {
			if (s.base.revision !== s.latest) this.set({ base: { ...s.base, revision: s.latest } });
			return;
		}
		if (s.base.revision === null || s.latest > s.base.revision) this.emit({ type: 'hydrate' });
	}

	// ── Leaving ─────────────────────────────────────────────────────────
	/** Prepared: let the page go, or ask. */
	decideLeave(): void {
		const leave = this.state.leave;
		if (!leave || leave.phase !== 'preparing') return;
		if (atRisk(this.state)) {
			this.set({ leave: { ...leave, phase: 'choosing' } });
			this.emit({ type: 'verdict', id: leave.id, leave: false });
		} else {
			this.set({ leave: null });
			this.emit({ type: 'verdict', id: leave.id, leave: true });
		}
	}

	/** The current decision is no longer current: it settles without acting. */
	retireLeave(): void {
		const leave = this.state.leave;
		if (!leave) return;
		this.emit(
			leave.phase === 'preparing'
				? { type: 'verdict', id: leave.id, leave: false }
				: { type: 'settled', id: leave.id, destination: null }
		);
		this.set({ leave: null });
	}

	/**
	 * Discard: nothing of the current values is sent, also not on the way out;
	 * the next edit saves again. A save already sent may still land, and live,
	 * what this tab already put into the shared session stays there.
	 */
	discard(): void {
		this.set({ discarded: true, failure: null, saveTimer: null });
		if (this.state.live) this.emit({ type: 'drop-unsent' });
	}
}
