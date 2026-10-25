/**
 * What a draft editor's session (`draftSession.ts`) means, derived: never
 * stored, so no two parts of the editor can disagree about it.
 */

import type { DraftSessionState } from './draftSessionTypes';

export type DraftSaveStatus =
	| 'idle'
	| 'editing'
	| 'saving'
	| 'offline'
	| 'saved'
	/** Not written to the email yet, and no save of this tab is due (others' live edits). */
	| 'unsaved'
	| 'error';

/**
 * The live session's field for this tab's own edits: a count that only grows,
 * so a save taken at a count holds every own edit up to it. It says nothing
 * about what others put into the session (`DraftLive.sharedPending`).
 */
export const OWN_EDITS = '@own';

/** Fields whose value the server does not hold. */
export const pendingFields = (s: DraftSessionState): string[] => {
	const base = s.base;
	if (!base) return [];
	return Object.keys(s.values).filter((field) => s.values[field] !== base.values[field]);
};

/**
 * The server holds what the editor shows: every field is what an
 * acknowledged save stored, and nothing is on its way or being typed. Live,
 * `@own` matching proves only that this tab's own edits are written; the
 * session must also hold nothing the email does not (anyone's edits) and
 * have taken every edit of this tab. The only coverage there is: nothing
 * else (presence, a query emission) lets the page go.
 */
export const serverHolds = (s: DraftSessionState): boolean =>
	!s.inline &&
	s.flight === null &&
	pendingFields(s).length === 0 &&
	!(s.live && (s.live.sharedPending || s.live.unsent));

/**
 * What a save would carry now. In the background, the live session is
 * written for this tab's own edits, and for others' only when nobody else is
 * left to write them. An explicit save (Save, the leave prompt, Publish)
 * writes whatever the editor shows, whoever made it.
 */
export const saveFields = (s: DraftSessionState, explicit = false): string[] => {
	const pending = pendingFields(s);
	if (s.live) {
		const shared = explicit
			? s.live.sharedPending || s.live.unsent
			: s.live.sharedPending && s.live.alone;
		return pending.length > 0 || shared ? [OWN_EDITS] : [];
	}
	return pending;
};

/** Background saving may run (a prompt or a final action holds it). */
export const canAutosave = (s: DraftSessionState): boolean =>
	s.enabled &&
	!s.closed &&
	!s.discarded &&
	s.base !== null &&
	s.conflict === null &&
	s.leave === null &&
	s.action === null;

/** Final action `id` may dispatch what the server holds: the editor shows exactly that. */
export const actionCurrent = (s: DraftSessionState, id: number): boolean =>
	s.action !== null && s.action.id === id && !s.closed && !s.discarded && serverHolds(s);

/** New collaboration sends wait while the person decides whether to leave. */
export const holdsSends = (s: DraftSessionState): boolean => s.leave !== null;

/** The draft holds an edit of this editor the server does not (for its own UI). */
export const isDirty = (s: DraftSessionState): boolean => pendingFields(s).length > 0;

/** Leaving now would lose something: what the leave guards ask about. */
export const atRisk = (s: DraftSessionState): boolean =>
	s.enabled && !s.closed && !s.discarded && !serverHolds(s);

export const saveStatus = (s: DraftSessionState): DraftSaveStatus => {
	if (!s.enabled || !s.base) return 'idle';
	if (s.discarded) return s.savedAt === null ? 'idle' : 'saved';
	if (s.inline) return 'editing';
	if (s.failure !== null && !s.flight) return 'error';
	const waiting = s.flight !== null || s.saveTimer !== null || saveFields(s).length > 0;
	if (waiting || !serverHolds(s)) {
		if (!s.online) return 'offline';
		return waiting ? 'saving' : 'unsaved';
	}
	return s.savedAt === null ? 'idle' : 'saved';
};
