/**
 * Email co-editing: saving the shared draft.
 *
 * The email `update` mutations take an optional `coeditVersion`. When it is
 * given and the email has a live session, the save writes the SESSION, not
 * the editor's payload: whatever operations reached the server before the
 * save, from every editor, are saved, so a tab that missed someone's edit
 * cannot write an older copy over it. The payload still carries the fields a
 * session does not share (translations, slug, the data-variable schema).
 *
 * Without a session (it ended while the tab stayed open) the payload is the
 * draft, as before co-editing; the revision check still guards it.
 */

import type { MutationCtx } from '../_generated/server';
import type { CoeditTarget } from '../lib/validators/coediting';
import { findSession, linkedBlockIdsOf, sessionDocOf, type CoeditSession } from './target';

/** The update arguments a save takes from the session instead of the payload. */
export interface CoeditSaveOverrides {
	content: string;
	name?: string;
	subject?: string;
	plainTextOverride?: string;
	plainTextContent?: string;
	linkedBlockIds: string[];
	attachments?: string;
	showUnsubscribe?: boolean;
}

export interface CoeditSave {
	session: CoeditSession;
	overrides: CoeditSaveOverrides;
}

/**
 * What a save with `coeditVersion` writes, or null when the save is not a
 * co-editing save or the email has no live session.
 */
export async function loadCoeditSave(
	ctx: MutationCtx,
	target: CoeditTarget,
	coeditVersion: number | undefined
): Promise<CoeditSave | null> {
	if (coeditVersion === undefined) return null;
	const session = await findSession(ctx, target);
	if (!session) return null;

	// A draft that does not decode refuses the save, so it cannot replace the email.
	const { blocks, fields } = sessionDocOf(session);
	const text = (key: string) => (typeof fields[key] === 'string' ? fields[key] : undefined);
	const plainTextOverride = text('plainTextOverride');
	const overrides: CoeditSaveOverrides = {
		content: session.content,
		name: text('name'),
		subject: text('subject'),
		plainTextOverride,
		linkedBlockIds: linkedBlockIdsOf(blocks),
	};
	// The author's own text/plain body is the effective one while it is set.
	if (plainTextOverride?.trim()) overrides.plainTextContent = plainTextOverride;
	if (target.type === 'transactionalEmail') {
		if (Array.isArray(fields['attachments'])) {
			overrides.attachments = JSON.stringify(fields['attachments']);
		}
		if (typeof fields['showUnsubscribe'] === 'boolean') {
			overrides.showUnsubscribe = fields['showUnsubscribe'];
		}
	}
	return { session, overrides };
}

/** The save landed as `contentRevision`: the session has nothing unsaved now. */
export async function markCoeditSaved(
	ctx: MutationCtx,
	save: CoeditSave,
	contentRevision: number
): Promise<void> {
	await ctx.db.patch(save.session._id, {
		savedVersion: save.session.version,
		baseRevision: contentRevision,
	});
}
