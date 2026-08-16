import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';

/**
 * The countdown-undo toast singleton behind review-queue approvals (piece C1):
 * arming replaces the previous window, the toast's runUndo executes the armed
 * surface's true inverse exactly once, and the narrowing helper only accepts a
 * real `undo: { sendAt }` window off an approve result.
 */
const stateBuckets = new Map<string, ReturnType<typeof ref>>();
vi.stubGlobal('useState', (key: string, init: () => unknown) => {
	if (!stateBuckets.has(key)) stateBuckets.set(key, ref(init()));
	return stateBuckets.get(key);
});

import { approveUndoWindow, useReviewApproveUndo } from '../useReviewApproveUndo';

describe('useReviewApproveUndo', () => {
	beforeEach(() => {
		stateBuckets.clear();
	});

	it('arm exposes the window; dismiss clears it', () => {
		const { state, arm, dismiss } = useReviewApproveUndo();
		expect(state.value.visible).toBe(false);

		arm({ inboundMessageId: 'msg_1', sendAt: 12345, onUndo: () => {} });
		expect(state.value).toEqual({ visible: true, inboundMessageId: 'msg_1', sendAt: 12345 });

		dismiss();
		expect(state.value).toEqual({ visible: false, inboundMessageId: null, sendAt: 0 });
	});

	it('runUndo runs the armed inverse once and dismisses first (no double-fire)', async () => {
		const { state, arm, runUndo } = useReviewApproveUndo();
		const onUndo = vi.fn().mockResolvedValue(undefined);
		arm({ inboundMessageId: 'msg_1', sendAt: Date.now() + 15_000, onUndo });

		await runUndo();
		expect(onUndo).toHaveBeenCalledTimes(1);
		expect(state.value.visible).toBe(false);

		// A second click on a lingering button is inert.
		await runUndo();
		expect(onUndo).toHaveBeenCalledTimes(1);
	});

	it('re-arming replaces the previous approval window and its inverse', async () => {
		const { state, arm, runUndo } = useReviewApproveUndo();
		const first = vi.fn();
		const second = vi.fn();
		arm({ inboundMessageId: 'msg_1', sendAt: 1000, onUndo: first });
		arm({ inboundMessageId: 'msg_2', sendAt: 2000, onUndo: second });

		expect(state.value.inboundMessageId).toBe('msg_2');
		await runUndo();
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});
});

describe('approveUndoWindow', () => {
	it('extracts an open undo window from an approve result', () => {
		expect(approveUndoWindow({ success: true, undo: { sendAt: 42 } })).toEqual({ sendAt: 42 });
	});

	it('returns undefined for windowless / malformed results', () => {
		expect(approveUndoWindow({ success: true })).toBeUndefined();
		expect(approveUndoWindow(undefined)).toBeUndefined();
		expect(approveUndoWindow(null)).toBeUndefined();
		expect(approveUndoWindow({ undo: {} })).toBeUndefined();
		expect(approveUndoWindow({ undo: { sendAt: 'soon' } })).toBeUndefined();
	});
});
