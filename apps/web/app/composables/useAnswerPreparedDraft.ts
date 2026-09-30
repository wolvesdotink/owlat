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
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function useAnswerPreparedDraft(opts: {
	threadId: () => string | undefined;
	/** Only a fresh reply takes one (a resumed draft already has its text). */
	enabled: () => boolean;
}) {
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

	return { text };
}
