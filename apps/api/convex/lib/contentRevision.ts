/**
 * Editor-content revision — a per-row counter on `emailTemplates` and
 * `transactionalEmails` that lets an editor save detect a concurrent writer.
 *
 * The editor builds one payload (blocks, rendered HTML, translated HTML, plain
 * text) from the row it loaded. If anything the payload was derived from
 * changed on the server in the meantime — another tab's save, a translation
 * edit, a saved-block propagation — writing it would silently replace that
 * change with HTML rendered from the old state. So every write to those fields
 * advances `contentRevision`, and a save that names the revision it was built
 * on is refused when the row has moved on.
 *
 * Only the fields an editor save derives its payload from count: name,
 * subject, preview text, block content and the translation overlays.
 * Bookkeeping writes (send counters, publish state, the data-variable schema,
 * a background re-render of the HTML) do not advance it, so they never make a
 * draft stale. A row that predates the field reads as revision 0.
 *
 * The editor `update` mutations return the revision they stored, so a client
 * never has to infer where its own write landed.
 */

import { throwConflict } from '../_utils/errors';

interface Revisioned {
	contentRevision?: number;
}

/** The revision a row is at; rows written before the field existed are 0. */
export function currentContentRevision(row: Revisioned): number {
	return row.contentRevision ?? 0;
}

/** The value to patch into `contentRevision` alongside an editor-content write. */
export function nextContentRevision(row: Revisioned): number {
	return currentContentRevision(row) + 1;
}

/** Which write a stale revision refused; picks the copy the editor shows. */
export type ContentRevisionGuardedWrite = 'save' | 'publish';

const STALE_COPY: Record<ContentRevisionGuardedWrite, { message: string; messageKey: string }> = {
	save: {
		message:
			'This email was changed somewhere else after you opened it, so your edits were not saved yet.',
		messageKey: 'shared.useEmailEditorBridge.staleRevision',
	},
	publish: {
		message:
			'This email was changed somewhere else after you opened it, so it was not published. Check the latest version, then publish again.',
		messageKey: 'shared.useEmailEditorBridge.stalePublish',
	},
};

/**
 * Refuse a write built on an older revision. `expected` is optional so callers
 * that do not track revisions (API scripts, older clients) keep writing
 * unconditionally.
 */
export function assertContentRevision(
	row: Revisioned,
	expected: number | undefined,
	write: ContentRevisionGuardedWrite = 'save'
): void {
	if (expected === undefined) return;
	const current = currentContentRevision(row);
	if (current === expected) return;
	const copy = STALE_COPY[write];
	throwConflict(copy.message, {
		reason: 'stale_content_revision',
		expectedRevision: expected,
		currentRevision: current,
		messageKey: copy.messageKey,
	});
}
