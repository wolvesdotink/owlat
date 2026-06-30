import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * Review Queue wiring for the shared-inbox approval page.
 *
 * The agent pipeline routes `complaint` / `urgent` messages straight to
 * `draft_ready` WITHOUT running the drafter (see
 * apps/api/convex/agent/steps/classify/index.ts), so those escalations land in
 * the queue with NO `draftResponse`. `approveDraft` hard-fails on a missing
 * draft (`throwInvalidState('No draft to approve')`), so for these items the
 * "Approve & Send" button can never work — the admin needs to compose a reply
 * first.
 *
 * `needsReply` distinguishes those draftless escalations. `composeAndSend`
 * writes the human-authored reply through the existing `editDraft` mutation
 * (which populates `draftResponse` / `draftSubject`) and then sends it via
 * `approveDraft` — exactly the edit→approve path the thread-detail page uses,
 * with no new backend surface.
 */
export function useReviewQueue() {
	const { data: reviewItems, isLoading } = useConvexQuery(
		api.inbox.queries.getReviewQueue,
		() => ({ limit: 50 }),
	);

	const { run: approveDraft } = useBackendOperation(api.inbox.mutations.approveDraft, {
		label: 'Approve draft',
	});
	const { run: rejectDraft } = useBackendOperation(api.inbox.mutations.rejectDraft, {
		label: 'Reject draft',
	});
	const { run: editDraft } = useBackendOperation(api.inbox.mutations.editDraft, {
		label: 'Save reply',
	});

	/**
	 * A queue item "needs reply" when it has no agent draft to approve — i.e. a
	 * complaint/urgent escalation that skipped the drafter. The empty string and
	 * whitespace-only guards mirror the thread-detail page, which only renders
	 * its Approve block when `draftResponse` is truthy.
	 */
	const needsReply = (message: { draftResponse?: string | null }): boolean => {
		const draft = message.draftResponse;
		return !draft || draft.trim().length === 0;
	};

	const onApprove = async (messageId: Id<'inboundMessages'>) => {
		return await approveDraft({ inboundMessageId: messageId });
	};

	const onReject = async (messageId: Id<'inboundMessages'>) => {
		return await rejectDraft({ inboundMessageId: messageId });
	};

	/**
	 * Compose a human reply for a draftless escalation and send it: persist the
	 * text via `editDraft`, then approve+queue via `approveDraft`. Both runs go
	 * through `useBackendOperation`, which toasts categorized failures and
	 * resolves to `undefined` — so we stop after a failed edit rather than
	 * approving an empty draft (which would re-throw `No draft to approve`).
	 */
	const composeAndSend = async (
		messageId: Id<'inboundMessages'>,
		body: string,
		subject?: string,
	) => {
		const text = body.trim();
		if (text.length === 0) return undefined;

		const edited = await editDraft({
			inboundMessageId: messageId,
			draftResponse: text,
			draftSubject: subject?.trim() || undefined,
		});
		if (edited === undefined) return undefined;

		return await approveDraft({ inboundMessageId: messageId });
	};

	return {
		reviewItems,
		isLoading,
		needsReply,
		onApprove,
		onReject,
		composeAndSend,
	};
}
