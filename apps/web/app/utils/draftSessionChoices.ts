/**
 * The transitions of a draft editor's session (`draftSession.ts`) that answer
 * a person's choice or end something: a copy left on the device, leaving the
 * page, a conflict, a final action, closing. Split out for the file-size cap.
 */

import {
	atRisk,
	copyFields,
	deviceCovers,
	pendingFields,
	sendableFields,
	volatilePending,
} from './draftSessionSelectors';
import { pick, type DraftStep } from './draftSessionStep';
import type { DraftCandidate, DraftEvent } from './draftSessionTypes';

type Of<K extends DraftEvent['type']> = Extract<DraftEvent, { type: K }>;

// ── Copies left on the device ──────────────────────────────────────────

export function recoveryStart(step: DraftStep, e: Of<'recovery-start'>): void {
	const s = step.state;
	if (s.closed || !s.base || s.recovery.scope === e.scope) return;
	const request = step.id();
	step.set({ recovery: { request, scope: e.scope }, offer: null });
	step.emit({ type: 'read-copies', request, scope: e.scope });
}

/**
 * Never applied on its own: a copy is offered, or, when it says what the
 * editor shows, it is nothing to offer. Saying the same is not keeping it:
 * such a copy goes only while the server or this editor's committed copy
 * holds what it holds; otherwise this editor takes it over and it goes once
 * that is so.
 */
export function recoveryRead(step: DraftStep, e: Of<'recovery-read'>): void {
	const s = step.state;
	if (e.request !== s.recovery.request || s.recovery.scope === null || s.closed || s.discarded) {
		return;
	}
	let offer: DraftCandidate | null = null;
	for (const candidate of e.candidates) {
		if (candidate.liveness === 'open') continue;
		if (!candidate.matches) {
			offer ??= candidate;
			continue;
		}
		// One whose editor may still be open stays that editor's.
		if (candidate.liveness !== 'closed') continue;
		const kept = pendingFields(s).length === 0 || (s.persistent && deviceCovers(s));
		if (kept) {
			step.emit({ type: 'remove-copies', key: candidate.key, tokens: [candidate.token] });
		} else if (!step.state.adopting) {
			step.set({ adopting: { source: candidate, values: pick(s.values, copyFields(s)) } });
			step.settleCopy();
		}
	}
	if (offer) {
		step.set({
			offer: { request: e.request, candidate: offer, revision: s.localRevision, confirm: false },
		});
	}
}

/**
 * Restore asks once more when it would replace newer work: an edit since the
 * offer, or text open in a block (which no edit counts yet). Confirmed, open
 * text is committed and then replaced with the rest (`apply-copy`).
 */
export function recoveryRestore(step: DraftStep): void {
	const s = step.state;
	const offer = s.offer;
	if (!offer || s.closed || offer.request !== s.recovery.request) return;
	if (offer.revision !== s.localRevision || (s.inline && !offer.confirm)) {
		step.set({ offer: { ...offer, revision: s.localRevision, confirm: true } });
		return;
	}
	step.set({ offer: null, adopting: { source: offer.candidate, values: {} } });
	step.emit({ type: 'apply-copy', request: offer.request, candidate: offer.candidate });
}

/**
 * The restored snapshot is an edit against the confirmed base (a server
 * write since still makes its save a conflict). It goes to this editor's own
 * copy at once; its source goes only once every field it restored is kept.
 */
export function recoveryApplied(step: DraftStep, e: Of<'recovery-applied'>): void {
	const s = step.state;
	const adopting = s.adopting;
	if (!adopting || e.request !== s.recovery.request) return;
	step.set({ adopting: { ...adopting, values: pick(s.values, copyFields(s)) } });
	if (s.persistent) step.writeCopy();
}

export function recoveryDiscard(step: DraftStep): void {
	const offer = step.state.offer;
	if (!offer) return;
	step.set({ offer: null });
	if (offer.candidate.liveness === 'closed') {
		step.emit({
			type: 'remove-copies',
			key: offer.candidate.key,
			tokens: [offer.candidate.token],
		});
	}
}

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
		leave: {
			id: e.id,
			phase: 'preparing',
			destination: e.destination,
			kind: e.kind,
			deadline: null,
			revision: s.localRevision,
		},
	});
	// A new tab opens inside the click: the page decides at once.
	if (e.kind === 'open-tab') step.decideLeave();
	else step.emit({ type: 'prepare-leave', id: e.id });
}

/** Open text is committed: give the device copy a bounded moment, then decide. */
export function leaveReady(step: DraftStep, e: Of<'leave-ready'>): void {
	const s = step.state;
	const leave = s.leave;
	if (!leave || leave.id !== e.id || leave.phase !== 'preparing') return;
	const copyWouldCover =
		atRisk(s) &&
		s.persistent &&
		!s.inline &&
		volatilePending(s).length === 0 &&
		pendingFields(s).length > 0 &&
		!deviceCovers(s);
	if (!copyWouldCover) {
		step.decideLeave();
		return;
	}
	step.settleCopy();
	if (step.state.writes.length === 0) {
		step.decideLeave();
		return;
	}
	const deadline = step.id();
	step.set({ leave: { ...step.state.leave!, deadline } });
	step.emit({ type: 'timer', name: 'leave', id: deadline, ms: s.leaveWaitMs });
}

export function leaveSave(step: DraftStep, e: Of<'leave-save'>): void {
	const leave = step.state.leave;
	if (!leave || leave.id !== e.id || leave.phase !== 'choosing') return;
	step.set({ leave: { ...leave, phase: 'saving', revision: step.state.localRevision } });
	step.emit({ type: 'flush-leave', id: e.id });
}

/**
 * The prompt's Save went through the queue. The page goes only when nothing
 * would be lost now and nothing was edited meanwhile; a page that stays open
 * (the email in a new tab) needs only the save.
 */
export function leaveSaved(step: DraftStep, e: Of<'leave-saved'>): void {
	const s = step.state;
	const leave = s.leave;
	// Retired meanwhile (Stay, a newer request, closing): it was settled then.
	if (!leave || leave.id !== e.id || leave.phase !== 'saving') return;
	const staysOpen = leave.kind === 'open-tab';
	const reason = !e.ok
		? 'unsaved'
		: staysOpen
			? null
			: s.localRevision !== leave.revision || s.inline
				? 'unsaved'
				: volatilePending(s).length > 0
					? 'schedule'
					: atRisk(s)
						? 'unkept'
						: null;
	if (reason) {
		step.set({ leave: { ...leave, phase: 'choosing' } });
		step.emit({ type: 'settled', id: e.id, destination: null, reason });
		return;
	}
	step.set({ leave: null, pass: staysOpen ? null : leave.destination });
	step.emit({ type: 'settled', id: e.id, destination: leave.destination });
	step.resume();
}

export function leaveDiscard(step: DraftStep, e: Of<'leave-discard'>): void {
	const leave = step.state.leave;
	if (!leave || leave.id !== e.id || leave.phase === 'saving') return;
	step.set({ leave: null });
	if (leave.kind === 'open-tab') {
		// The page stays open in its tab and keeps its edits.
		step.emit({ type: 'settled', id: e.id, destination: leave.destination });
		step.resume();
		return;
	}
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
	if (step.state.saveTimer === null && !step.state.flight && sendableFields(step.state).length) {
		step.armSave(0);
	}
}

/** "Load latest": the draft is replaced by the server's state, copies and all. */
export function reload(step: DraftStep): void {
	step.set({ conflict: null, failure: null, saveTimer: null, mirrorTimer: null, keepOver: null });
	// Live, the session is reset to the email: this tab's edits go with it.
	const base = step.state.base;
	if (step.state.live && base) step.set({ base: { ...base, values: step.state.values } });
	step.dropOwnCopies();
	step.emit({ type: 'reload' });
}

// ── Final actions and closing ───────────────────────────────────────────

export function actionEnd(step: DraftStep, e: Of<'action-end'>): void {
	const action = step.state.action;
	if (!action || action.id !== e.id) return;
	step.set({ action: null });
	const base = step.state.base;
	if (e.ok && base && e.consumed.length > 0) {
		// Only what the action consumed, as it was when the action began.
		step.set({ base: { ...base, values: { ...base.values, ...pick(action.values, e.consumed) } } });
	}
	step.resume();
}

/**
 * Closing retires every open decision and timer. What was not discarded gets
 * one last save and device copy with what the editor holds now (best effort);
 * a discarded draft sends and keeps nothing.
 */
export function close(step: DraftStep): void {
	const s = step.state;
	if (s.closed) return;
	step.retireLeave();
	const finalSave =
		s.enabled &&
		!s.discarded &&
		!s.conflict &&
		!s.flight &&
		s.base !== null &&
		sendableFields(s).length > 0;
	const finalCopy = s.mirrorTimer !== null;
	step.set({ offer: null, adopting: null, saveTimer: null, mirrorTimer: null, pass: null });
	if (finalCopy) step.settleCopy();
	if (finalSave) step.startFlight();
	if (s.live && !s.discarded) step.emit({ type: 'send-unsent' });
	step.set({ closed: true, epoch: step.state.epoch + 1 });
}
