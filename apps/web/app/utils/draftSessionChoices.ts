/**
 * The transitions of a draft editor's session (`draftSession.ts`) that answer
 * a person's choice or end something: leaving the page, a conflict, a final
 * action, closing. Split out for the file-size cap.
 */

import { atRisk, saveFields } from './draftSessionSelectors';
import type { DraftStep } from './draftSessionStep';
import type { DraftEvent } from './draftSessionTypes';

type Of<K extends DraftEvent['type']> = Extract<DraftEvent, { type: K }>;

// ── Leaving ─────────────────────────────────────────────────────────────

/**
 * A leave request is a new decision: it retires the previous one and holds
 * background saves and collaboration sends at once, before anything is
 * prepared. A navigation a decision already let go passes.
 */
export function leaveRequested(step: DraftStep, e: Of<'leave-requested'>): void {
	const s = step.state;
	if (s.pass !== null && s.pass === e.destination) {
		step.set({ pass: null });
		step.emit({ type: 'verdict', id: e.id, leave: true });
		return;
	}
	step.retireLeave();
	step.set({ pass: null, saveTimer: null });
	if (!s.enabled || s.discarded || s.closed || !s.base) {
		step.emit({ type: 'verdict', id: e.id, leave: true });
		return;
	}
	step.set({
		leave: { id: e.id, phase: 'preparing', destination: e.destination, revision: s.localRevision },
	});
	step.emit({ type: 'prepare-leave', id: e.id });
}

/** Open text is committed: decide on what the server holds now. */
export function leaveReady(step: DraftStep, e: Of<'leave-ready'>): void {
	const leave = step.state.leave;
	if (!leave || leave.id !== e.id || leave.phase !== 'preparing') return;
	step.decideLeave();
}

export function leaveSave(step: DraftStep, e: Of<'leave-save'>): void {
	const leave = step.state.leave;
	if (!leave || leave.id !== e.id || leave.phase !== 'choosing') return;
	step.set({ leave: { ...leave, phase: 'saving', revision: step.state.localRevision } });
	step.emit({ type: 'flush-leave', id: e.id });
}

/**
 * The prompt's Save went through the queue. The page goes only when the
 * server holds what the editor shows and nothing was edited meanwhile.
 */
export function leaveSaved(step: DraftStep, e: Of<'leave-saved'>): void {
	const s = step.state;
	const leave = s.leave;
	// Retired meanwhile (Stay, a newer request, closing): it was settled then.
	if (!leave || leave.id !== e.id || leave.phase !== 'saving') return;
	if (!e.ok || s.localRevision !== leave.revision || atRisk(s)) {
		step.set({ leave: { ...leave, phase: 'choosing' } });
		step.emit({ type: 'settled', id: e.id, destination: null, refused: true });
		return;
	}
	step.set({ leave: null, pass: leave.destination });
	step.emit({ type: 'settled', id: e.id, destination: leave.destination });
	step.resume();
}

export function leaveDiscard(step: DraftStep, e: Of<'leave-discard'>): void {
	const leave = step.state.leave;
	if (!leave || leave.id !== e.id || leave.phase === 'saving') return;
	step.set({ leave: null });
	step.discard();
	step.set({ pass: leave.destination });
	step.emit({ type: 'settled', id: e.id, destination: leave.destination });
}

export function leaveCancel(step: DraftStep, e: Of<'leave-cancel'>): void {
	const leave = step.state.leave;
	if (!leave || (e.id !== undefined && leave.id !== e.id)) return;
	step.retireLeave();
	step.resume();
}

// ── Conflict ────────────────────────────────────────────────────────────

/** "Keep my version": built on the named revision now, and saved again. */
export function rebased(step: DraftStep, e: Of<'rebased'>): void {
	const s = step.state;
	if (!s.conflict) return;
	if (s.live) {
		step.set({ conflict: null, failure: null, keepOver: e.revision });
	} else {
		step.set({
			conflict: null,
			failure: null,
			base: { revision: e.revision, values: e.base },
			values: e.values,
			localRevision: s.localRevision + 1,
			latest: Math.max(s.latest ?? e.revision, e.revision),
		});
	}
	step.resume();
	if (step.state.saveTimer === null && !step.state.flight && saveFields(step.state).length) {
		step.armSave(0);
	}
}

/** "Load latest": the draft is replaced by the server's state. */
export function reload(step: DraftStep): void {
	step.set({ conflict: null, failure: null, saveTimer: null, keepOver: null });
	// Live, the session is reset to the email: this tab's edits go with it.
	const base = step.state.base;
	if (step.state.live && base) step.set({ base: { ...base, values: step.state.values } });
	step.emit({ type: 'reload' });
}

// ── Final actions and closing ───────────────────────────────────────────

export function actionEnd(step: DraftStep, e: Of<'action-end'>): void {
	const action = step.state.action;
	if (!action || action.id !== e.id) return;
	step.set({ action: null });
	step.resume();
}

/**
 * Closing retires every open decision and the save timer, and starts
 * nothing: what is not saved by then was left through the prompt's Discard or
 * the browser's own warning. A save already sent may still land.
 */
export function close(step: DraftStep): void {
	if (step.state.closed) return;
	step.retireLeave();
	step.set({ saveTimer: null, pass: null, closed: true, epoch: step.state.epoch + 1 });
}
