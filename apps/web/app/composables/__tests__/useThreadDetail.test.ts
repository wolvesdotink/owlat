import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import { useThreadDetail } from '../useThreadDetail';
import { queryResult } from '~/__tests__/queryStubs';

// Called outside a component here, so `useI18n` is stubbed with the real
// catalog's `t`.
const { t, locale } = createTestI18n().global;

/**
 * The thread composer sends a person's reply by saving it as the working draft
 * and then approving it. `saveEditedDraft` must do both, in that order, and
 * never approve after a failed save; `saveDraftOnly` saves without approving.
 */
describe('useThreadDetail', () => {
	// One mock run() per useBackendOperation call, in declaration order:
	// 0 = approveDraft, 1 = rejectDraft, 2 = editDraft, 3 = assignThread,
	// 4 = updateThreadStatus, 5 = retryFailedMessage, 6 = snoozeThread,
	// 7 = unsnoozeThread, 8 = saveDraftRevision, 9 = sendFollowUp,
	// 10 = cancelFollowUp.
	let runs: Array<ReturnType<typeof vi.fn>>;

	beforeEach(() => {
		runs = [];
		vi.stubGlobal('useI18n', () => ({ t, locale }));
		vi.stubGlobal('useConvexQuery', () => queryResult(undefined));
		vi.stubGlobal('useBackendOperation', () => {
			const run = vi.fn().mockResolvedValue({ ok: true, result: { success: true } });
			runs.push(run);
			return { run };
		});
	});

	const approveRun = () => runs[0]!;
	const editRun = () => runs[2]!;
	const saveRevisionRun = () => runs[8]!;
	const sendFollowUpRun = () => runs[9]!;
	const cancelFollowUpRun = () => runs[10]!;

	const threadId = ref('thread_1' as never);
	const messageId = 'msg_1' as never;

	describe('saveEditedDraft', () => {
		it('persists the reply via editDraft then approves via approveDraft', async () => {
			const detail = useThreadDetail(threadId);

			const result = await detail.saveEditedDraft(messageId, {
				body: 'Edited reply body',
				subject: 'Re: question',
			});

			expect(editRun()).toHaveBeenCalledWith({
				inboundMessageId: messageId,
				draftResponse: 'Edited reply body',
				draftSubject: 'Re: question',
			});
			expect(approveRun()).toHaveBeenCalledWith({ inboundMessageId: messageId });
			expect(result).toEqual({ ok: true, result: { success: true } });
		});

		it('omits an empty subject', async () => {
			const detail = useThreadDetail(threadId);

			await detail.saveEditedDraft(messageId, { body: 'Body only', subject: '' });

			expect(editRun()).toHaveBeenCalledWith({
				inboundMessageId: messageId,
				draftResponse: 'Body only',
				draftSubject: undefined,
			});
		});

		it('does not approve when the save fails (no spurious transition)', async () => {
			const detail = useThreadDetail(threadId);
			// useBackendOperation.run resolves `ok: false` on a categorized failure.
			editRun().mockResolvedValueOnce({ ok: false });

			const result = await detail.saveEditedDraft(messageId, { body: 'A reply', subject: '' });

			expect(result).toEqual({ ok: false });
			expect(approveRun()).not.toHaveBeenCalled();
		});

		it('reports a failed approve', async () => {
			const detail = useThreadDetail(threadId);
			approveRun().mockResolvedValueOnce({ ok: false });

			const result = await detail.saveEditedDraft(messageId, { body: 'A reply', subject: '' });

			expect(result).toEqual({ ok: false });
			expect(editRun()).toHaveBeenCalledOnce();
		});
	});

	describe('saveDraftOnly', () => {
		it('saves via saveDraftRevision and never touches approveDraft', async () => {
			const detail = useThreadDetail(threadId);

			const result = await detail.saveDraftOnly(messageId, {
				body: 'Work in progress',
				subject: 'Re: later',
			});

			expect(saveRevisionRun()).toHaveBeenCalledWith({
				inboundMessageId: messageId,
				draftResponse: 'Work in progress',
				draftSubject: 'Re: later',
			});
			expect(approveRun()).not.toHaveBeenCalled();
			expect(result).toEqual({ ok: true, result: { success: true } });
		});
	});

	// #807 — an answered thread takes a follow-up: its own send, keyed to the
	// thread, never the edit → approve path of the answered message.
	describe('follow-ups', () => {
		it('sends a follow-up on the thread without touching the draft path', async () => {
			const detail = useThreadDetail(threadId);

			await detail.sendFollowUp({ body: 'One more thing', subject: 'Re: question' });

			expect(sendFollowUpRun()).toHaveBeenCalledWith({
				threadId: 'thread_1',
				body: 'One more thing',
				subject: 'Re: question',
			});
			expect(editRun()).not.toHaveBeenCalled();
			expect(approveRun()).not.toHaveBeenCalled();
		});

		it('undoes a follow-up by id', async () => {
			const detail = useThreadDetail(threadId);

			await detail.cancelFollowUp('followUp_1' as never);

			expect(cancelFollowUpRun()).toHaveBeenCalledWith({ followUpId: 'followUp_1' });
		});
	});
});
