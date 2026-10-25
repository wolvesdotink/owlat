/**
 * One draft email template editor's session: the single owner of what the
 * editor holds, the server state it is built on, what is on its way to the
 * server, and whether the page may be left.
 *
 * Pure: `transition(state, event)` returns the next state and the effects to
 * run. `useDraftAutosave.ts` runs them (the save timer, the save mutation,
 * the leave prompt's steps) and reports each outcome as an event naming the
 * effect it belongs to (a flight id, a decision id). An outcome whose name no
 * longer matches belongs to a retired effect: it changes nothing it does not
 * prove. Retiring an effect does not cancel a mutation Convex already took.
 *
 * What the editor holds is described per field by a fingerprint (its value,
 * serialized). Live co-editing has one field, `@own`, counting this tab's own
 * edits: the session merges everyone's, and what the shared session holds
 * unwritten is reported beside it (`DraftLive`). A field is covered while
 * its fingerprint equals the base's; only a hydration, an acknowledged save
 * of that exact value or an explicit rebase move the base. Nothing is kept
 * on the device: until the server acknowledged an edit, leaving asks. The
 * selectors in `draftSessionSelectors.ts` derive everything else (dirty, at
 * risk, the save status) from this state.
 */

import {
	actionEnd,
	close,
	leaveCancel,
	leaveDiscard,
	leaveReady,
	leaveRequested,
	leaveSave,
	leaveSaved,
	rebased,
	reload,
} from './draftSessionChoices';
import { OWN_EDITS, canAutosave, pendingFields, saveFields } from './draftSessionSelectors';
import { DraftStep, pick } from './draftSessionStep';
import type { DraftEffect, DraftEvent, DraftSessionState, Fingerprints } from './draftSessionTypes';

export type * from './draftSessionTypes';

export interface DraftSessionConfig {
	debounceMs?: number;
}

export const DRAFT_DEBOUNCE_MS = 1500;

export { OWN_EDITS };

export function createDraftSession(config: DraftSessionConfig = {}): DraftSessionState {
	return {
		debounceMs: config.debounceMs ?? DRAFT_DEBOUNCE_MS,
		epoch: 0,
		closed: false,
		enabled: false,
		online: true,
		live: null,
		hydration: 0,
		base: null,
		latest: null,
		ownRevision: null,
		keepOver: null,
		localRevision: 0,
		values: {},
		inline: false,
		discarded: false,
		flight: null,
		saveTimer: null,
		failure: null,
		savedAt: null,
		conflict: null,
		leave: null,
		pass: null,
		action: null,
		next: 1,
	};
}

const unchanged = (current: Fingerprints, next: Fingerprints) =>
	Object.keys(next).every((key) => current[key] === next[key]);

type Of<K extends DraftEvent['type']> = Extract<DraftEvent, { type: K }>;

export function transition(
	state: DraftSessionState,
	event: DraftEvent
): { state: DraftSessionState; effects: DraftEffect[] } {
	const step = new DraftStep(state);
	const e = event;
	switch (e.type) {
		case 'enabled':
			step.set({ enabled: e.enabled });
			if (e.enabled) step.resume();
			else step.set({ saveTimer: null });
			break;
		case 'online': {
			const cameBack = e.online && !step.state.online;
			step.set({ online: e.online });
			if (cameBack) step.resume(true);
			break;
		}
		case 'hydrated':
			hydrated(step, e);
			break;
		case 'transfer':
			// The editor switches to this session holding work another owner
			// tracked: kept, built on that owner's base.
			step.set({
				base: { revision: e.revision, values: e.dirty ? {} : e.values },
				values: e.values,
				hydration: step.state.hydration + 1,
				latest: e.revision,
			});
			step.resume();
			break;
		case 'rebaseline': {
			// The editor settled what a hydration wrote (normalized it): still
			// the server's state, not an edit.
			const base = step.state.base;
			if (e.hydration !== step.state.hydration || !base || step.state.live) break;
			step.set({
				base: { ...base, values: { ...base.values, ...e.values } },
				values: { ...step.state.values, ...e.values },
			});
			break;
		}
		case 'observed':
			observed(step, e);
			break;
		case 'edit': {
			const s = step.state;
			// Off (a published template): the owner that takes over reads the fields itself.
			if (!s.enabled || !s.base || s.live || s.closed) break;
			if (unchanged(s.values, e.values)) break;
			step.set({ values: { ...s.values, ...e.values } });
			step.localEdit();
			break;
		}
		case 'live-edit': {
			const s = step.state;
			if (!s.enabled || !s.live || !s.base || s.closed) break;
			step.set({ values: { [OWN_EDITS]: String(s.localRevision + 1) } });
			step.localEdit();
			break;
		}
		case 'live':
			live(step, e);
			break;
		case 'inline':
			if (e.open === step.state.inline) break;
			step.set({ inline: e.open });
			if (!e.open) step.catchUp();
			break;
		case 'timer':
			timer(step, e);
			break;
		case 'save-now': {
			const s = step.state;
			if (!s.enabled || !s.base || s.closed || s.discarded || s.conflict || s.flight) break;
			step.startFlight(true);
			break;
		}
		case 'retry': {
			const conflict = step.state.conflict;
			if (conflict) {
				step.set({ conflict: { ...conflict, open: true } });
				break;
			}
			// Retry is the person's choice: it saves what the editor shows, as Save does.
			step.set({ failure: null, saveTimer: null });
			const s = step.state;
			if (canAutosave(s) && !s.flight) step.startFlight(true);
			break;
		}
		case 'saved':
			saved(step, e);
			break;
		case 'save-failed': {
			const flight = step.state.flight;
			if (!flight || flight.id !== e.flight) break;
			step.set({ flight: null });
			// A save of what another entity or hydration replaced says nothing about this draft.
			if (flight.epoch !== step.state.epoch || flight.hydration !== step.state.hydration) break;
			step.set({ failure: e.error ?? new Error('Saving failed') });
			if (e.conflict !== null) {
				step.set({
					conflict: { revision: e.conflict, mustReload: false, open: true },
					latest: Math.max(step.state.latest ?? e.conflict, e.conflict),
				});
			}
			break;
		}
		case 'leave-requested':
			leaveRequested(step, e);
			break;
		case 'leave-ready':
			leaveReady(step, e);
			break;
		case 'leave-save':
			leaveSave(step, e);
			break;
		case 'leave-saved':
			leaveSaved(step, e);
			break;
		case 'leave-discard':
			leaveDiscard(step, e);
			break;
		case 'leave-cancel':
			leaveCancel(step, e);
			break;
		case 'discard':
			step.retireLeave();
			step.discard();
			break;
		case 'conflict-dismiss': {
			const conflict = step.state.conflict;
			if (conflict) step.set({ conflict: { ...conflict, open: false } });
			break;
		}
		case 'rebased':
			rebased(step, e);
			break;
		case 'rebase-refused': {
			const conflict = step.state.conflict;
			if (conflict) step.set({ conflict: { ...conflict, mustReload: true, open: true } });
			break;
		}
		case 'reload':
			reload(step);
			break;
		case 'action-begin':
			step.set({ action: { id: e.id }, saveTimer: null });
			break;
		case 'action-end':
			actionEnd(step, e);
			break;
		case 'close':
			close(step);
			break;
	}
	return { state: step.state, effects: step.effects };
}

/** The editor shows a server state: the draft is built on it, clean. */
function hydrated(step: DraftStep, e: Of<'hydrated'>) {
	const latest = step.state.latest;
	step.set({
		base: { revision: e.revision, values: e.values },
		values: e.values,
		hydration: step.state.hydration + 1,
		latest: e.revision === null ? latest : Math.max(latest ?? e.revision, e.revision),
		conflict: null,
		failure: null,
		keepOver: null,
	});
	if (e.fresh) {
		// Another entity: nothing of the previous one carries over.
		step.set({ epoch: step.state.epoch + 1, ownRevision: null, discarded: false, saveTimer: null });
	}
	step.resume();
}

/**
 * A server row arrived. Only a clean draft with no open text follows it; a
 * dirty one keeps its base, so its save still names the revision it was built
 * on and a newer write comes up as a conflict.
 */
function observed(step: DraftStep, e: Of<'observed'>) {
	const s = step.state;
	step.set({ latest: Math.max(s.latest ?? e.revision, e.revision) });
	if (!s.base || s.live || s.closed) return;
	if (pendingFields(s).length > 0 || s.inline || s.flight) return;
	if (e.revision === s.ownRevision) {
		// This editor's own save coming back (normalized): build on it, keep
		// what is being typed.
		step.set({ base: { ...s.base, revision: e.revision } });
	} else if (s.base.revision === null || e.revision > s.base.revision) {
		step.emit({ type: 'hydrate' });
	}
	// Otherwise the same state, or an emission from before a write already acknowledged.
}

function live(step: DraftStep, e: Of<'live'>) {
	const s = step.state;
	if (e.live === null) {
		if (s.live) step.set({ live: null, base: null, values: {} });
		return;
	}
	if (s.live) {
		step.set({ live: e.live });
	} else {
		const own = { [OWN_EDITS]: String(s.localRevision) };
		step.set({
			live: e.live,
			base: { revision: e.live.base, values: own },
			values: own,
			hydration: s.hydration + 1,
		});
	}
	step.resume();
}

function timer(step: DraftStep, e: Of<'timer'>) {
	const s = step.state;
	if (e.id !== s.saveTimer) return;
	step.set({ saveTimer: null });
	if (canAutosave(step.state) && !s.flight) step.startFlight();
}

/**
 * A save landed: exactly what it carried is covered, and the base moves to
 * the revision it stored. Edits made meanwhile stay pending.
 */
function saved(step: DraftStep, e: Of<'saved'>) {
	const s = step.state;
	const flight = s.flight;
	if (!flight || flight.id !== e.flight) return;
	step.set({ flight: null, failure: null, savedAt: e.at, conflict: null });
	if (flight.epoch !== s.epoch || flight.hydration !== s.hydration || !s.base) return;
	let revision = s.base.revision;
	if (e.receipt.revision !== undefined) {
		revision = e.receipt.revision;
		step.set({ ownRevision: revision, latest: Math.max(s.latest ?? revision, revision) });
	}
	step.set({
		base: { revision, values: { ...s.base.values, ...pick(flight.values, flight.included) } },
		keepOver: null,
	});
	step.catchUp();
	if (!step.state.discarded) step.resume();
}
