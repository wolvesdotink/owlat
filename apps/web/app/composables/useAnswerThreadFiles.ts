/**
 * Turning a file from the thread (a catch-up chip) into an attachment of the
 * reply, or into the answer to a file question.
 *
 * The server copies an existing file onto a draft by its `mailAttachments` id
 * (`mail.drafts.attachExisting`, no download and re-upload). A message row does
 * not carry that id, so it is looked up in the mailbox's attachment index by
 * filename, then by sender, and matched on message and MIME part. Mail the
 * index does not hold (older mail before its backfill, a part it skips) falls
 * back to what the reader's download does: the part is cut out of the message
 * here and uploaded like a file from disk.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { ThreadFile } from '~/utils/answerThreadFiles';
import { loadRawEml } from '~/composables/postbox/loadRawEml';
import { loadMessagePart } from '~/composables/postbox/loadMessagePart';
import { useMimePartDownload } from '~/composables/useMimePartDownload';

/** How far back each index lookup reads. */
const LOOKUP_LIMIT = 100;

export function useAnswerThreadFiles(opts: { mailboxId: () => Id<'mailboxes'> | undefined }) {
	const { extractPartBlob } = useMimePartDownload({
		loadRaw: loadRawEml,
		loadPart: loadMessagePart,
		failureKey: 'components.answer.catchUp.attachFailed',
	});
	const resolved = new Map<string, Id<'mailAttachments'> | null>();

	/** The file's `mailAttachments` id, or null when the index does not hold it. */
	async function indexIdOf(file: ThreadFile): Promise<Id<'mailAttachments'> | null> {
		if (resolved.has(file.key)) return resolved.get(file.key) ?? null;
		const mailboxId = opts.mailboxId();
		if (!mailboxId) return null;
		const convex = requireConvex();
		if (!file.partIndex) return null;
		const match = (rows: { _id: Id<'mailAttachments'>; messageId: string; partIndex: string }[]) =>
			rows.find((row) => row.messageId === file.messageId && row.partIndex === file.partIndex)
				?._id ?? null;
		let id: Id<'mailAttachments'> | null = null;
		try {
			const byName = await convex.query(api.mail.mailbox.attachments.list, {
				mailboxId,
				filenameQuery: file.filename,
				limit: LOOKUP_LIMIT,
			});
			id = match(byName.files);
			const sender = file.fromAddress;
			if (!id && sender) {
				const bySender = await convex.query(api.mail.mailbox.attachments.list, {
					mailboxId,
					fromAddress: sender.toLowerCase(),
					limit: LOOKUP_LIMIT,
				});
				id = match(bySender.files);
			}
		} catch {
			id = null;
		}
		resolved.set(file.key, id);
		return id;
	}

	/** The file's bytes as a `File`, cut out of its message. */
	async function toFile(file: ThreadFile): Promise<File | null> {
		const blob = await extractPartBlob(file.messageId, {
			filename: file.filename,
			contentType: file.contentType,
			size: file.size,
			...(file.partIndex ? { partIndex: file.partIndex } : {}),
		});
		return blob ? new File([blob], file.filename, { type: blob.type || file.contentType }) : null;
	}

	return { indexIdOf, toFile };
}
