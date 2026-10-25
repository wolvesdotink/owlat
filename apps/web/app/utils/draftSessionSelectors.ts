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
	/** Saved, but a choice no draft save stores could not be kept on this device. */
	| 'unkept'
	/** Saved; scheduling choices wait for Schedule. */
	| 'scheduling'
	| 'error';

/** The fields a device copy stores: everything but the volatile ones. */
export const copyFields = (s: DraftSessionState): string[] =>
	Object.keys(s.values).filter((field) => !s.volatile.includes(field));

/** Fields (volatile ones aside) whose value the server does not hold. */
export const pendingFields = (s: DraftSessionState): string[] => {
	const base = s.base;
	if (!base) return [];
	return copyFields(s).filter((field) => s.values[field] !== base.values[field]);
};

/** Volatile fields changed from what the server holds. */
export const volatilePending = (s: DraftSessionState): string[] => {
	const base = s.base;
	if (!base) return [];
	return s.volatile.filter((field) => field in s.values && s.values[field] !== base.values[field]);
};

/**
 * What a save would carry now. Live, the session is written for this tab's
 * own edits, or for others' that nobody else is left to write.
 */
export const sendableFields = (s: DraftSessionState): string[] => {
	const pending = pendingFields(s);
	if (s.live) return pending.length > 0 || (s.live.sharedPending && s.live.alone) ? ['@own'] : [];
	return pending.filter((field) => !s.deviceOnly.includes(field));
};

/** The last committed copy holds every stored field as it is now. */
export const deviceCovers = (s: DraftSessionState): boolean => {
	const disk = s.onDisk;
	return disk !== null && copyFields(s).every((field) => disk.values[field] === s.values[field]);
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

/**
 * Final action `id` may dispatch what the server holds: the editor shows
 * exactly that (nothing on its way, nothing pending, no open text), and the
 * volatile choices it consumes are the ones it began with.
 */
export const actionCurrent = (
	s: DraftSessionState,
	id: number,
	consumes: readonly string[] = []
): boolean => {
	const action = s.action;
	return (
		action !== null &&
		action.id === id &&
		!s.closed &&
		!s.discarded &&
		!s.inline &&
		s.flight === null &&
		pendingFields(s).length === 0 &&
		consumes.every((field) => s.values[field] === action.values[field])
	);
};

/** New collaboration sends wait while the person decides whether to leave. */
export const holdsSends = (s: DraftSessionState): boolean => s.leave !== null;

/** The draft holds something the server does not (for the editor's own UI). */
export const isDirty = (s: DraftSessionState): boolean =>
	pendingFields(s).length > 0 || volatilePending(s).length > 0;

export const onDevice = (s: DraftSessionState): boolean => s.persistent && deviceCovers(s);

/** Leaving now would lose something: what the leave guards ask about. */
export const atRisk = (s: DraftSessionState): boolean =>
	s.enabled &&
	!s.closed &&
	!s.discarded &&
	(s.inline ||
		volatilePending(s).length > 0 ||
		(pendingFields(s).length > 0 && !(s.persistent && deviceCovers(s))));

export const saveStatus = (s: DraftSessionState): DraftSaveStatus => {
	if (!s.enabled || !s.base) return 'idle';
	if (s.inline) return 'editing';
	if (s.failure !== null && !s.flight) return 'error';
	const pending = pendingFields(s);
	const waiting = s.flight !== null || s.saveTimer !== null || sendableFields(s).length > 0;
	if (waiting && !s.discarded) return s.online ? 'saving' : 'offline';
	if (pending.length > 0 && !s.discarded) {
		if (s.writes.length > 0) return 'saving';
		if (!onDevice(s)) return 'unkept';
	}
	if (volatilePending(s).length > 0 && !s.discarded) return 'scheduling';
	return s.savedAt === null ? 'idle' : 'saved';
};
