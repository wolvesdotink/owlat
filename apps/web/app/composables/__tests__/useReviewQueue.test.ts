import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { useReviewQueue } from '../useReviewQueue';

/**
 * Regression tests for the Review Queue draftless-escalation fix.
 *
 * The agent pipeline routes complaint/urgent messages straight to `draft_ready`
 * WITHOUT a draft (agent/steps/classify/index.ts), so the queue surfaces them
 * with no `draftResponse`. Approving such a message hard-fails with
 * `No draft to approve`. The queue must instead detect these (`needsReply`) and
 * offer compose→send, which writes the reply via `editDraft` then sends it via
 * `approveDraft`.
 */
describe('useReviewQueue', () => {
	// One mock run() per useBackendOperation call, in call order:
	// 0 = approveDraft, 1 = rejectDraft, 2 = editDraft.
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

	describe('needsReply', () => {
		it('flags a draftless escalation', () => {
			const { needsReply } = useReviewQueue();
			expect(needsReply({ draftResponse: undefined })).toBe(true);
			expect(needsReply({ draftResponse: null })).toBe(true);
			expect(needsReply({ draftResponse: '' })).toBe(true);
			expect(needsReply({ draftResponse: '   \n' })).toBe(true);
		});

		it('does not flag a message that has an agent draft', () => {
			const { needsReply } = useReviewQueue();
			expect(needsReply({ draftResponse: 'Hello, thanks for reaching out.' })).toBe(false);
		});
	});

	describe('composeAndSend', () => {
		const messageId = 'msg_1' as never;

		it('writes the reply via editDraft then sends via approveDraft', async () => {
			const { composeAndSend } = useReviewQueue();

			const result = await composeAndSend(
				messageId,
				'  We are looking into it.  ',
				'  Re: outage '
			);

			// Trimmed body + subject persisted via editDraft.
			expect(editRun()).toHaveBeenCalledWith({
				inboundMessageId: messageId,
				draftResponse: 'We are looking into it.',
				draftSubject: 'Re: outage',
			});
			// Then approved/sent.
			expect(approveRun()).toHaveBeenCalledWith({ inboundMessageId: messageId });
			expect(result).toEqual({ success: true });
		});

		it('omits an empty subject', async () => {
			const { composeAndSend } = useReviewQueue();
			await composeAndSend(messageId, 'Body only', '   ');
			expect(editRun()).toHaveBeenCalledWith({
				inboundMessageId: messageId,
				draftResponse: 'Body only',
				draftSubject: undefined,
			});
		});

		it('refuses to send an empty body (never touches the backend)', async () => {
			const { composeAndSend } = useReviewQueue();
			const result = await composeAndSend(messageId, '   ');
			expect(result).toBeUndefined();
			expect(editRun()).not.toHaveBeenCalled();
			expect(approveRun()).not.toHaveBeenCalled();
		});

		it('does not approve when the edit fails (avoids the empty-draft error)', async () => {
			const { composeAndSend } = useReviewQueue();
			// useBackendOperation.run resolves to undefined on a categorized failure.
			editRun().mockResolvedValueOnce(undefined);

			const result = await composeAndSend(messageId, 'A reply');

			expect(result).toBeUndefined();
			expect(approveRun()).not.toHaveBeenCalled();
		});
	});

	describe('approveOption', () => {
		const messageId = 'msg_1' as never;
		const primary = 'Your order shipped Friday.';

		it('approves directly when the picked option IS the current default draft', async () => {
			const { approveOption } = useReviewQueue();
			const result = await approveOption(messageId, primary, primary);
			// No edit — the default draft is already persisted.
			expect(editRun()).not.toHaveBeenCalled();
			expect(approveRun()).toHaveBeenCalledWith({ inboundMessageId: messageId });
			expect(result).toEqual({ success: true });
		});

		it('persists a DIFFERENT picked option via editDraft then approves', async () => {
			const { approveOption } = useReviewQueue();
			const result = await approveOption(messageId, '  A more cautious reply.  ', primary);
			// The picked variant is written (trimmed) then sent — the pick is a
			// preference signal recorded by editDraft.
			expect(editRun()).toHaveBeenCalledWith({
				inboundMessageId: messageId,
				draftResponse: 'A more cautious reply.',
			});
			expect(approveRun()).toHaveBeenCalledWith({ inboundMessageId: messageId });
			expect(result).toEqual({ success: true });
		});

		it('does not approve when persisting the picked option fails', async () => {
			const { approveOption } = useReviewQueue();
			editRun().mockResolvedValueOnce(undefined);
			const result = await approveOption(messageId, 'A different reply.', primary);
			expect(result).toBeUndefined();
			expect(approveRun()).not.toHaveBeenCalled();
		});

		it('refuses an empty pick (never touches the backend)', async () => {
			const { approveOption } = useReviewQueue();
			const result = await approveOption(messageId, '   ', primary);
			expect(result).toBeUndefined();
			expect(editRun()).not.toHaveBeenCalled();
			expect(approveRun()).not.toHaveBeenCalled();
		});
	});
});
