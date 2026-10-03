import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestI18n } from '~/__tests__/i18n';
import { useReviewQueue } from '../useReviewQueue';
import { queryResult } from '~/__tests__/queryStubs';
import type { OperationError } from '@owlat/shared/operationError';

// The queue is stood up outside a component here, so `useI18n` is stubbed with
// the real catalog's `t` — the operation labels stay the English an admin reads.
const { t } = createTestI18n().global;

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
	// 0 = approveDraft, 1 = rejectDraft, 2 = editDraft, 3 = undoAutoSend.
	let runs: Array<ReturnType<typeof vi.fn>>;
	// The options each operation was built with, in the same order.
	let ops: Array<{ onError?: (op: OperationError) => boolean }>;
	let showToast: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		runs = [];
		ops = [];
		showToast = vi.fn();
		vi.stubGlobal('useI18n', () => ({ t }));
		vi.stubGlobal('useToast', () => ({ showToast }));
		vi.stubGlobal('useConvexQuery', () => queryResult(undefined));
		vi.stubGlobal(
			'useBackendOperation',
			(_fn: unknown, opts: { onError?: (op: OperationError) => boolean }) => {
				const run = vi.fn().mockResolvedValue({ ok: true, result: { success: true } });
				runs.push(run);
				ops.push(opts);
				return { run };
			}
		);
	});

	const approveRun = () => runs[0]!;
	const editRun = () => runs[2]!;
	const undoRun = () => runs[3]!;

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
			expect(result).toEqual({ ok: true, result: { success: true } });
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
			expect(result).toEqual({ ok: false });
			expect(editRun()).not.toHaveBeenCalled();
			expect(approveRun()).not.toHaveBeenCalled();
		});

		// Piece FU3: the surfaces branch on the approve mutation's soft errors, so
		// the queue must hand them back verbatim rather than flattening them into
		// the "sent" shape (or into the failure arm a categorized fault returns).
		it('hands the lost-race soft error back to the caller unchanged', async () => {
			const { composeAndSend } = useReviewQueue();
			approveRun().mockResolvedValueOnce({
				ok: true,
				result: { success: false, reason: 'not_found' },
			});

			const result = await composeAndSend(messageId, 'A reply');

			expect(result).toEqual({ ok: true, result: { success: false, reason: 'not_found' } });
		});

		it('does not approve when the edit fails (avoids the empty-draft error)', async () => {
			const { composeAndSend } = useReviewQueue();
			// useBackendOperation.run resolves `ok: false` on a categorized failure.
			editRun().mockResolvedValueOnce({ ok: false });

			const result = await composeAndSend(messageId, 'A reply');

			expect(result).toEqual({ ok: false });
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
			expect(result).toEqual({ ok: true, result: { success: true } });
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
			expect(result).toEqual({ ok: true, result: { success: true } });
		});

		it('does not approve when persisting the picked option fails', async () => {
			const { approveOption } = useReviewQueue();
			editRun().mockResolvedValueOnce({ ok: false });
			const result = await approveOption(messageId, 'A different reply.', primary);
			expect(result).toEqual({ ok: false });
			expect(approveRun()).not.toHaveBeenCalled();
		});

		it('refuses an empty pick (never touches the backend)', async () => {
			const { approveOption } = useReviewQueue();
			const result = await approveOption(messageId, '   ', primary);
			expect(result).toEqual({ ok: false });
			expect(editRun()).not.toHaveBeenCalled();
			expect(approveRun()).not.toHaveBeenCalled();
		});
	});

	// Piece D1': saved drafts ("Saved · edited by you") float to the top of the
	// queue, most recently saved first; the rest keep the server's order.
	describe('saved-first sort bump', () => {
		it('bumps saved drafts above untouched ones, newest save first', () => {
			const items = [
				{ message: { _id: 'a' } },
				{ message: { _id: 'b', draftSavedAt: 100 } },
				{ message: { _id: 'c' } },
				{ message: { _id: 'd', draftSavedAt: 200 } },
			];
			vi.stubGlobal('useConvexQuery', () => queryResult(items));

			const { reviewItems } = useReviewQueue();

			expect(reviewItems.value?.map((it) => it.message._id)).toEqual(['d', 'b', 'a', 'c']);
		});

		it('leaves a queue with no saved drafts in the server order', () => {
			const items = [{ message: { _id: 'a' } }, { message: { _id: 'b' } }];
			vi.stubGlobal('useConvexQuery', () => queryResult(items));

			const { reviewItems } = useReviewQueue();

			expect(reviewItems.value?.map((it) => it.message._id)).toEqual(['a', 'b']);
		});
	});

	// #1185: the agent's `[[...]]` gaps are stored gap-guarded, so Approve is
	// refused (DRAFT_HAS_GAPS) until they are filled. The queue card says so in
	// its own words, counting the gaps, instead of a generic failure toast.
	describe('a draft with gaps left', () => {
		const gapRefusal: OperationError = {
			category: 'invalid_state',
			message: 'Fill in the highlighted gaps before sending',
			data: { code: 'DRAFT_HAS_GAPS' },
		};
		const approveOnError = () => ops[0]!.onError!;

		/** The approve run fails the way `useBackendOperation` does: onError first. */
		function refuseApprove() {
			approveRun().mockImplementationOnce(async () => {
				approveOnError()(gapRefusal);
				return { ok: false };
			});
		}

		it('names how many gaps the agent draft still has', async () => {
			vi.stubGlobal('useConvexQuery', () =>
				queryResult([
					{
						message: {
							_id: 'msg_1',
							draftResponse: 'Your refund of [[amount]] lands by [[date]].',
						},
					},
				])
			);
			const { onApprove } = useReviewQueue();
			refuseApprove();

			const result = await onApprove('msg_1' as never);

			expect(result).toEqual({ ok: false });
			expect(showToast).toHaveBeenCalledWith(
				'This draft still has 2 gaps: fill in or delete each [[...]] before you send it.',
				'error'
			);
		});

		it('counts the picked option’s gaps', async () => {
			const { approveOption } = useReviewQueue();
			refuseApprove();

			await approveOption('msg_1' as never, 'It ships on [[date]].', 'It ships soon.');

			expect(showToast).toHaveBeenCalledWith(
				'This draft still has 1 gap: fill in or delete the [[...]] before you send it.',
				'error'
			);
		});

		it('leaves every other failure to the generic handling', () => {
			useReviewQueue();
			expect(approveOnError()({ category: 'invalid_state', message: 'No draft to approve' })).toBe(
				false
			);
			expect(showToast).not.toHaveBeenCalled();
		});
	});

	// Piece C1: the undo window a human approve now opens server-side.
	describe('undoApprove', () => {
		const messageId = 'msg_1' as never;

		it('calls undoAutoSend for the message and returns its outcome', async () => {
			const { undoApprove } = useReviewQueue();
			undoRun().mockResolvedValueOnce({ cancelled: true, reason: 'cancelled' });

			const result = await undoApprove(messageId);

			expect(undoRun()).toHaveBeenCalledWith({ inboundMessageId: messageId });
			expect(result).toEqual({ cancelled: true, reason: 'cancelled' });
		});

		it('surfaces the clean no-op when the window has already closed', async () => {
			const { undoApprove } = useReviewQueue();
			undoRun().mockResolvedValueOnce({ cancelled: false, reason: 'already_sent' });

			const result = await undoApprove(messageId);

			expect(result).toEqual({ cancelled: false, reason: 'already_sent' });
		});
	});
});
