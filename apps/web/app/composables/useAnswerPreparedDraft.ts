/**
 * A reply the AI already wrote for this thread before Answer mode opened
 * (plan §04): the Reply Queue's clarification draft (written after the person
 * answered its questions) or, failing that, the draft-on-arrival slot. Answer
 * mode opens a fresh reply with it in the editor and a quiet
 * "AI draft · Discard" tag.
 *
 * The clarification draft is the more informed of the two (it has the
 * person's answers), so it wins when both exist.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function useAnswerPreparedDraft(opts: {
	threadId: () => string | undefined;
	mailboxId: () => string | undefined;
	/** Only a fresh reply takes one (a resumed draft already has its text). */
	enabled: () => boolean;
}) {
	const slotQuery = useConvexQuery(api.mail.needsReply.getDraftSlot, () => {
		const threadId = opts.threadId();
		return opts.enabled() && threadId
			? { threadId: threadId as Id<'mailThreads'> }
			: ('skip' as const);
	});
	const queueQuery = useConvexQuery(api.mail.needsReply.listQueue, () => {
		const mailboxId = opts.mailboxId();
		return opts.enabled() && mailboxId
			? { mailboxId: mailboxId as Id<'mailboxes'> }
			: ('skip' as const);
	});

	const text = computed<string | null>(() => {
		const threadId = opts.threadId();
		if (!opts.enabled() || !threadId) return null;
		const row = queueQuery.data.value?.items.find((item) => item.threadId === threadId);
		const answered = row?.clarification?.draft?.trim();
		if (answered) return answered;
		return slotQuery.data.value?.draft?.trim() || null;
	});

	return { text };
}
