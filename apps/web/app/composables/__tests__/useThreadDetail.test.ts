import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { useThreadDetail } from '../useThreadDetail';

/**
 * Regression tests for the thread-detail "Save & Approve" button.
 *
 * The edit-mode button is labelled "Save & Approve", so `saveEditedDraft` must
 * persist the edited draft via `editDraft` AND then fire `approveDraft` so the
 * message transitions to `approved` and is queued for sending. It previously
 * only ran `editDraft`, leaving the message in `draft_ready` and forcing a
 * second "Approve & Send" click — the label promised an approval it never did.
 */
describe('useThreadDetail', () => {
	// One mock run() per useBackendOperation call, in declaration order:
	// 0 = approveDraft, 1 = rejectDraft, 2 = editDraft, 3 = assignThread,
	// 4 = updateThreadStatus, 5 = retryFailedMessage.
	let runs: Array<ReturnType<typeof vi.fn>>;

	beforeEach(() => {
		runs = [];
		vi.stubGlobal('useConvexQuery', () => ({ data: ref(undefined), isLoading: ref(false) }));
		vi.stubGlobal('useBackendOperation', () => {
			const run = vi.fn().mockResolvedValue({ success: true });
			runs.push(run);
			return { run };
		});
	});

	const approveRun = () => runs[0]!;
	const editRun = () => runs[2]!;

	const threadId = ref('thread_1' as never);
	const messageId = 'msg_1' as never;

	describe('saveEditedDraft', () => {
		it('persists the edited draft via editDraft then approves via approveDraft', async () => {
			const detail = useThreadDetail(threadId);
			detail.editedDraftResponse.value = 'Edited reply body';
			detail.editedDraftSubject.value = 'Re: question';
			detail.isEditingDraft.value = true;

			const result = await detail.saveEditedDraft(messageId);

			expect(editRun()).toHaveBeenCalledWith({
				inboundMessageId: messageId,
				draftResponse: 'Edited reply body',
				draftSubject: 'Re: question',
			});
			expect(approveRun()).toHaveBeenCalledWith({ inboundMessageId: messageId });
			expect(result).toEqual({ success: true });
			// Editing mode closes only once both steps succeed.
			expect(detail.isEditingDraft.value).toBe(false);
		});

		it('omits an empty subject', async () => {
			const detail = useThreadDetail(threadId);
			detail.editedDraftResponse.value = 'Body only';
			detail.editedDraftSubject.value = '';

			await detail.saveEditedDraft(messageId);

			expect(editRun()).toHaveBeenCalledWith({
				inboundMessageId: messageId,
				draftResponse: 'Body only',
				draftSubject: undefined,
			});
		});

		it('does not approve when the save fails (no spurious transition)', async () => {
			const detail = useThreadDetail(threadId);
			detail.editedDraftResponse.value = 'A reply';
			detail.isEditingDraft.value = true;
			// useBackendOperation.run resolves to undefined on a categorized failure.
			editRun().mockResolvedValueOnce(undefined);

			const result = await detail.saveEditedDraft(messageId);

			expect(result).toBeUndefined();
			expect(approveRun()).not.toHaveBeenCalled();
			// Stays in edit mode so the user can retry without losing their text.
			expect(detail.isEditingDraft.value).toBe(true);
		});

		it('keeps the user in edit mode when the approve step fails', async () => {
			const detail = useThreadDetail(threadId);
			detail.editedDraftResponse.value = 'A reply';
			detail.isEditingDraft.value = true;
			approveRun().mockResolvedValueOnce(undefined);

			const result = await detail.saveEditedDraft(messageId);

			expect(result).toBeUndefined();
			expect(editRun()).toHaveBeenCalledOnce();
			expect(detail.isEditingDraft.value).toBe(true);
		});
	});
});
