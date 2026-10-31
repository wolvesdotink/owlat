'use node';

/**
 * Answer mode's file answers, before the commit (mail/ai/composeDraft.ts): an
 * existing file is copied onto the draft, a fresh upload is checked and left
 * for the answer's commit (mail/ai/composeDraftCommit.ts) to attach.
 */

import type { Infer } from 'convex/values';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import type { AnswerAskTarget } from '../../lib/validators/answerAsk';
import { copyExistingIntoDraft } from '../attachExisting';
import type { pendingUploadValidator } from './composeDraftCommit';
import type { AskFileRef } from './composeDraftPolicy';

export type PendingUpload = Infer<typeof pendingUploadValidator>;

/** A Files copy the owner asked to keep of an uploaded answer. */
export interface KeepCopy {
	storageId: Id<'_storage'>;
	filename: string;
	contentType: string;
}

/**
 * Attach an existing file (a Files row or an earlier email's attachment). A
 * draft gets its copy now: `copyExistingIntoDraft` leaves a copy the draft
 * already holds alone, so a re-sent answer or a second start attaches it once.
 * A team thread only gets the reference checked and reported.
 */
export async function attachExistingFile(
	ctx: ActionCtx,
	target: AnswerAskTarget,
	file: { source: Exclude<AskFileRef['source'], 'upload'>; id: string }
): Promise<AskFileRef> {
	if (target.kind === 'mailDraft') {
		const copied = await copyExistingIntoDraft(ctx, {
			draftId: target.draftId,
			source: file.source,
			id: file.id,
		});
		return { source: file.source, id: file.id, filename: copied.filename };
	}
	const readable = await ctx.runQuery(internal.mail.attachExisting.resolveReadableFile, file);
	return { source: file.source, id: file.id, filename: readable.filename };
}

/**
 * Prepare a file answer for `answer`'s commit. A fresh upload is only checked
 * here: the commit puts it on the draft (`pendingUploadValidator`), so an
 * answer that fails leaves it unused for the next try, and an upload the
 * session already holds (sent again after a draft that failed) or names twice
 * is attached once; the commit refuses a held one the draft no longer has. It is also kept in Files for the contact unless the owner
 * opted out, when the caller may add to Files
 * (lib/answerFileToFiles.ts); that copy is made after the commit.
 */
export async function prepareFileAnswer(
	ctx: ActionCtx,
	session: Doc<'answerAskSessions'>,
	file: AskFileRef,
	keepCopy: boolean,
	seen: Set<string>
): Promise<{ ref: AskFileRef; upload?: PendingUpload; keep?: KeepCopy }> {
	if (file.source !== 'upload') {
		return {
			ref: await attachExistingFile(ctx, session.target, { source: file.source, id: file.id }),
		};
	}
	const filename =
		file.filename
			.replace(/[\r\n\t]/g, ' ')
			.trim()
			.slice(0, 255) || 'attachment';
	const storageId = file.id as Id<'_storage'>;
	const ref: AskFileRef = { source: 'upload', id: storageId, filename };
	const isHeld = session.attachedFiles.some((f) => f.source === 'upload' && f.id === storageId);
	if (isHeld || seen.has(storageId)) return { ref };
	seen.add(storageId);
	const info = await ctx.runQuery(internal.mail.ai.composeDraftContext.ownUploadInfo, {
		storageId,
	});
	const { contentType, size } = info;
	return {
		ref,
		...(session.target.kind === 'mailDraft'
			? { upload: { storageId, filename, contentType, size } }
			: {}),
		...(keepCopy && session.contactId && info.canSaveToFiles
			? { keep: { storageId, filename, contentType } }
			: {}),
	};
}
