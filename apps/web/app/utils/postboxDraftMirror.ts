/**
 * The composer's local draft mirror — the pure half (plan idea 7).
 *
 * Autosave is server-only on a 1.5s debounce, so a tab crash, a killed browser
 * or a device that fell off the network loses every keystroke since the last
 * `drafts.update`. The mirror writes the live compose fields into the on-device
 * store far more often than that, and on reopen offers them back.
 *
 * THE RECONCILE IS CLOCK-FREE. Comparing a client `Date.now()` against the
 * server's `lastEditedAt` would make the offer depend on device clock skew, in
 * both directions: a fast clock resurrects stale text over a newer save, a slow
 * one never offers anything. So every mirror records the SERVER timestamp it
 * was taken against ({@link DraftMirrorEntry.serverEditedAt}) and reconcile
 * compares server clock to server clock:
 *
 *   - the server row moved on since the mirror was written → the server wins,
 *     the mirror is stale (another tab or device saved), offer nothing;
 *   - the mirror's fields already match the server row → nothing was lost,
 *     offer nothing;
 *   - otherwise the mirror holds keystrokes the server never received → offer
 *     "Restore unsaved changes".
 *
 * `savedAt` (the client clock) is carried for DISPLAY only — the "from 14:32"
 * in the restore bar — and is never part of the decision.
 *
 * Module scope: no Vue, no IndexedDB, no i18n. The store keys/persistence live
 * in `postboxOfflineStore.ts`, the wiring in `usePostboxDraftMirror.ts`.
 */

/**
 * The mirrored slice of composer state: everything a person types, and nothing
 * that is a reference to server-side state.
 *
 * Attachments are deliberately absent — an attachment only exists once it has
 * been committed to a draft row server-side, so restoring a list of storage ids
 * from a local mirror could only ever re-attach files the server already has
 * (or, worse, ids it no longer has). The mirror is for keystrokes.
 */
export interface DraftMirrorFields {
	toAddresses: string[];
	ccAddresses: string[];
	bccAddresses: string[];
	subject: string;
	bodyHtml: string;
	/** Serialized EditorBlock[]; only ever present in 'full' composer mode. */
	bodyBlocks?: string;
	// Spelled out rather than imported from `usePostboxCompose` so this module
	// stays a leaf with no composable (and therefore no Vue) dependency, exactly
	// like `OfflineComposePayload` in postboxOfflineStore.
	composerMode: 'simple' | 'full';
}

/** One stored mirror: the fields, when they were taken, against which row. */
export interface DraftMirrorEntry {
	fields: DraftMirrorFields;
	/** Client clock, for the restore bar's "from …" only. Never a decision. */
	savedAt: number;
	/**
	 * The server's `lastEditedAt` for this draft as the mirroring tab last knew
	 * it, or 0 for a composition that never had a server row. Reconcile compares
	 * this against the row's CURRENT `lastEditedAt` — both server clock.
	 */
	serverEditedAt: number;
}

/** What the composer should do with a mirror it found on open. */
export type DraftMirrorVerdict = 'none' | 'restore';

const EMPTY_HTML = /^(?:\s|<br\s*\/?>|<\/?(?:p|div|span)[^>]*>|&nbsp;)*$/i;

/** True when body HTML carries no actual content (an empty contenteditable). */
function isBlankHtml(html: string): boolean {
	return EMPTY_HTML.test(html.trim());
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * Do two field sets carry the same message? Compared field by field rather than
 * by a serialized digest so an incidental key-order difference between a stored
 * mirror and a freshly-built snapshot cannot read as an edit.
 */
export function draftMirrorFieldsEqual(a: DraftMirrorFields, b: DraftMirrorFields): boolean {
	return (
		sameList(a.toAddresses, b.toAddresses) &&
		sameList(a.ccAddresses, b.ccAddresses) &&
		sameList(a.bccAddresses, b.bccAddresses) &&
		a.subject === b.subject &&
		a.bodyHtml === b.bodyHtml &&
		(a.bodyBlocks ?? '') === (b.bodyBlocks ?? '') &&
		a.composerMode === b.composerMode
	);
}

/** True when a snapshot holds nothing worth mirroring (a blank composer). */
export function isBlankDraftFields(fields: DraftMirrorFields): boolean {
	return (
		fields.toAddresses.length === 0 &&
		fields.ccAddresses.length === 0 &&
		fields.bccAddresses.length === 0 &&
		fields.subject.trim().length === 0 &&
		isBlankHtml(fields.bodyHtml) &&
		(fields.bodyBlocks ?? '[]') === '[]'
	);
}

export interface DraftMirrorReconcileInput {
	/** The mirror read back from the device, or null when there is none. */
	mirror: DraftMirrorEntry | null;
	/**
	 * The server row's current `lastEditedAt`, or null when this composition has
	 * no server row yet (a fresh compose that never autosaved).
	 */
	serverEditedAt: number | null;
	/**
	 * The fields as the server holds them, or null when there is no server row.
	 * With no row, any non-blank mirror is by definition unsaved work.
	 */
	serverFields: DraftMirrorFields | null;
}

/**
 * Decide what to do with the mirror found on composer open. See the module
 * header for why this never touches a client clock.
 */
export function reconcileDraftMirror(input: DraftMirrorReconcileInput): DraftMirrorVerdict {
	const { mirror, serverEditedAt, serverFields } = input;
	if (!mirror) return 'none';
	// A mirror of an empty composer is not work; offering to restore blankness
	// would be pure noise on every reopen of a draft the user cleared out.
	if (isBlankDraftFields(mirror.fields)) return 'none';
	if (serverFields === null) return 'restore';
	// The row was saved AFTER this mirror was taken — by another tab, another
	// device, or this tab's own autosave landing post-crash. The server is then
	// strictly the better copy and the mirror is stale.
	if (serverEditedAt !== null && serverEditedAt > mirror.serverEditedAt) return 'none';
	if (draftMirrorFieldsEqual(mirror.fields, serverFields)) return 'none';
	return 'restore';
}
