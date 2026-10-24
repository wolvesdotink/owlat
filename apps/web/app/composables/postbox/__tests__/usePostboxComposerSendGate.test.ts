/**
 * The composer's send path, in order: an upload in flight (explained, not
 * sent), the seal gate, the confidence layer, the stale-reply check, then the
 * send; a gate that parks the send stops everything after it, and only a send
 * that went out is reported.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { flushPromises } from '@vue/test-utils';

const showToast = vi.fn();
const showOperationError = vi.fn();
const guardsBlock = vi.fn((_opts?: unknown) => false);
const staleBlock = vi.fn(() => false);

vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
vi.stubGlobal('useToast', () => ({ showToast }));
vi.stubGlobal('useOperationErrorToast', () => ({ showOperationError }));
vi.stubGlobal('usePostboxStaleReplyGuard', () => ({
	staleReplyByName: ref(null),
	confirmOpen: ref(false),
	blockSend: staleBlock,
	confirm: vi.fn(),
}));
// The confidence layer replays a parked send through the gate's own handleSend.
let guardsConfirm: (opts?: unknown) => void = () => {};
vi.stubGlobal(
	'usePostboxComposerGuards',
	(_sources: unknown, hooks: { onConfirm: (opts?: unknown) => void }) => {
		guardsConfirm = hooks.onConfirm;
		return { blockSend: guardsBlock };
	}
);

import { usePostboxComposerSendGate } from '../usePostboxComposerSendGate';

function makeGate(over: { uploading?: boolean; canSend?: boolean; sealBlocks?: boolean } = {}) {
	const send = vi.fn(async () => ({ undoToken: 't', sendAt: 1 }));
	const onSent = vi.fn();
	const sealBlock = vi.fn(async () => over.sealBlocks === true);
	const gate = effectScope().run(() =>
		usePostboxComposerSendGate({
			seed: () => ({ mailboxId: 'mbx_1' as never, inReplyToMessageId: 'msg_1' as never }),
			identities: () => [],
			fromAddress: () => '',
			subject: () => 'Re: hi',
			bodyHtml: () => '<p>hi</p>',
			recipients: () => ['a@example.com'],
			attachmentCount: () => 0,
			isUploading: () => over.uploading === true,
			canSend: () => over.canSend !== false,
			seal: () => ({ blockSend: sealBlock }),
			send,
			onSent,
		})
	)!;
	return { gate, send, onSent, sealBlock };
}

beforeEach(() => {
	showToast.mockClear();
	showOperationError.mockClear();
	guardsBlock.mockReset().mockReturnValue(false);
	staleBlock.mockReset().mockReturnValue(false);
});

describe('usePostboxComposerSendGate', () => {
	it('sends through every gate and reports the send', async () => {
		const { gate, send, onSent } = makeGate();
		await gate.handleSend({ scheduledSendAt: 42 });
		expect(send).toHaveBeenCalledWith({ scheduledSendAt: 42 });
		expect(onSent).toHaveBeenCalledWith({ scheduled: true, done: false });
		expect(gate.sending.value).toBe(false);
	});

	it('reports a reply that marks its conversation done', async () => {
		const { gate, send, onSent } = makeGate();
		await gate.handleSend({ afterSend: 'done' });
		expect(send).toHaveBeenCalledWith({ afterSend: 'done' });
		expect(onSent).toHaveBeenCalledWith({ scheduled: false, done: true });
	});

	it('replays a parked send with the action chosen when Send was pressed', async () => {
		const { gate, send, onSent } = makeGate();
		let parked: unknown;
		guardsBlock.mockImplementationOnce((opts?: unknown) => {
			parked = opts;
			return true;
		});
		await gate.handleSend({ afterSend: 'done' });
		expect(send).not.toHaveBeenCalled();

		guardsConfirm(parked);
		await flushPromises();
		expect(send).toHaveBeenCalledWith({ afterSend: 'done' });
		expect(onSent).toHaveBeenCalledWith({ scheduled: false, done: true });
	});

	it('explains an upload in flight instead of sending', async () => {
		const { gate, send } = makeGate({ uploading: true });
		await gate.handleSend();
		expect(showToast).toHaveBeenCalledWith('components.postbox.postboxComposer.uploadingToast');
		expect(send).not.toHaveBeenCalled();
	});

	it('stops at the first gate that parks the send', async () => {
		const sealed = makeGate({ sealBlocks: true });
		await sealed.gate.handleSend();
		expect(sealed.send).not.toHaveBeenCalled();
		expect(guardsBlock).not.toHaveBeenCalled();

		guardsBlock.mockReturnValue(true);
		const guarded = makeGate();
		await guarded.gate.handleSend();
		expect(guarded.send).not.toHaveBeenCalled();
		expect(staleBlock).not.toHaveBeenCalled();

		guardsBlock.mockReturnValue(false);
		staleBlock.mockReturnValue(true);
		const stale = makeGate();
		await stale.gate.handleSend();
		expect(stale.send).not.toHaveBeenCalled();
	});

	it('stays put and says why when the send throws', async () => {
		const { gate, send, onSent } = makeGate();
		send.mockRejectedValueOnce(new Error('No draft'));
		await gate.handleSend();
		expect(onSent).not.toHaveBeenCalled();
		expect(showOperationError).toHaveBeenCalledTimes(1);
	});
});
