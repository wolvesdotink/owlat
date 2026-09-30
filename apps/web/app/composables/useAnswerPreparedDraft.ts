/**
 * A reply the AI already wrote for this thread before Answer mode opened
 * (plan §04): the Reply Queue's clarification draft (written after the person
 * answered its questions) or, failing that, the draft-on-arrival slot. Answer
 * mode opens a fresh reply with it in the editor and a quiet
 * "AI draft · Discard" tag.
 *
 * The clarification draft is the more informed of the two (it has the
 * person's answers), so it wins when both exist. Both come from one
 * per-thread read (`needsReplyPrepared.getPreparedDraft`), not from the whole
 * mailbox's queue.
 *
 * The files the person gave as answers there come with it (`files`), and
 * `attachFiles` puts them on the reply's draft once the text is in: a Files
 * row or an earlier email's attachment is copied (`drafts.attachExisting`), an
 * upload is bound as it is (`drafts.addAttachment`). A file that cannot be
 * attached gets a quiet note and never holds the draft up.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { AnswerComposerApi } from '~/composables/postbox/usePostboxComposerAnswerApi';
import type { ComposerAttachment } from '~/composables/postbox/usePostboxComposeAttachments';
import { answerUploadContentType } from '~/utils/answerFilePicker';

/** A file answer the prepared reply carries. */
export interface PreparedFile {
	source: 'upload' | 'semanticFile' | 'mailAttachment';
	id: string;
	filename: string;
}

export function useAnswerPreparedDraft(opts: {
	threadId: () => string | undefined;
	/** Only a fresh reply takes one (a resumed draft already has its text). */
	enabled: () => boolean;
}) {
	const { t } = useI18n();
	const { showToast } = useToast();

	const preparedQuery = useConvexQuery(api.mail.needsReplyPrepared.getPreparedDraft, () => {
		const threadId = opts.threadId();
		return opts.enabled() && threadId
			? { threadId: threadId as Id<'mailThreads'> }
			: ('skip' as const);
	});

	const text = computed<string | null>(() => {
		if (!opts.enabled() || !opts.threadId()) return null;
		const prepared = preparedQuery.data.value;
		return prepared?.clarificationDraft ?? prepared?.slotDraft ?? null;
	});

	// Read tolerantly: older deployments return no `files`.
	const files = computed<PreparedFile[]>(() => {
		const prepared = preparedQuery.data.value as { files?: PreparedFile[] } | null | undefined;
		return prepared?.files ?? [];
	});

	// A failure is said once, quietly, by `attachFiles`; not as an error toast.
	const quiet = { onError: () => true, announce: false } as const;
	const attachExisting = useBackendOperation(api.mail.drafts.attachExisting, {
		label: () => t('components.answer.catchUp.attachOperation'),
		type: 'action',
		...quiet,
	});
	const addAttachment = useBackendOperation(api.mail.drafts.addAttachment, {
		label: () => t('components.answer.catchUp.attachOperation'),
		...quiet,
	});

	async function attachOne(draftId: Id<'mailDrafts'>, file: PreparedFile): Promise<boolean> {
		if (file.source === 'upload') {
			const result = await addAttachment.run({
				draftId,
				storageId: file.id as Id<'_storage'>,
				filename: file.filename,
				contentType: answerUploadContentType(file.filename),
				// The server measures the stored blob; this is only its hint.
				size: 0,
			});
			return result.ok;
		}
		const result = await attachExisting.run({ draftId, source: file.source, id: file.id });
		return result.ok;
	}

	/** Put the prepared reply's files on the composer's draft (after its text). */
	async function attachFiles(composer: AnswerComposerApi): Promise<void> {
		const list = files.value;
		if (list.length === 0) return;
		const draftId = await composer.ensureDraftId();
		const failed: string[] = [];
		if (!draftId) failed.push(...list.map((f) => f.filename));
		else for (const file of list) if (!(await attachOne(draftId, file))) failed.push(file.filename);
		if (draftId) {
			try {
				const draft = await requireConvex().query(api.mail.drafts.get, { draftId });
				const attachments = (draft as { attachments?: ComposerAttachment[] } | null)?.attachments;
				if (attachments) composer.setAttachments(attachments);
			} catch {
				// The chips catch up on the next open; the files are on the draft.
			}
		}
		for (const filename of failed) {
			showToast(t('components.answer.aiBar.preparedFileFailed', { filename }), 'info');
		}
	}

	return { text, files, attachFiles };
}
