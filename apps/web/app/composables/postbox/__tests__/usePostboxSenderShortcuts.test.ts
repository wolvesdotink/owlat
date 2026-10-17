/**
 * ⇧E / ⇧U from the open message (SPEC §5): the sender chords name the sender
 * by the message, and a one-click sender gets the chip's confirm with its host.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';
import { usePostboxSenderShortcuts } from '../usePostboxSenderShortcuts';

const setStatus = vi.fn(async () => true);
const unsubscribe = vi.fn(async () => true);

beforeAll(() => {
	vi.stubGlobal('usePostboxSenderActions', () => ({ setStatus, unsubscribe }));
});

beforeEach(() => {
	setStatus.mockClear();
	unsubscribe.mockClear();
});

const mailboxId = computed(() => 'mb1' as never);
const message = {
	_id: 'm1',
	fromAddress: 'news@shop.example',
	fromName: 'Shop',
	unsubscribe: { oneClick: true, httpUrl: 'https://lists.shop.example/u?x=1' },
};

describe('usePostboxSenderShortcuts', () => {
	it('⇧E sets the sender of the open message to Auto-archive', () => {
		const { runSenderShortcut } = usePostboxSenderShortcuts(mailboxId);
		expect(runSenderShortcut('senderAutoArchive', message)).toBe(true);
		expect(setStatus).toHaveBeenCalledWith({ messageId: 'm1' }, 'auto_archive', 'Shop');
	});

	it('⇧U unsubscribes behind the chip’s confirm for a one-click sender', () => {
		const { runSenderShortcut } = usePostboxSenderShortcuts(mailboxId);
		runSenderShortcut('senderUnsubscribe', message);
		expect(unsubscribe).toHaveBeenCalledWith(
			{ messageId: 'm1' },
			{ mailboxId: 'mb1', name: 'Shop', oneClickHost: 'lists.shop.example' }
		);
		runSenderShortcut('senderUnsubscribe', { ...message, unsubscribe: undefined });
		expect(unsubscribe).toHaveBeenLastCalledWith(
			{ messageId: 'm1' },
			{ mailboxId: 'mb1', name: 'Shop', oneClickHost: null }
		);
	});

	it('leaves every other action alone', () => {
		const { runSenderShortcut } = usePostboxSenderShortcuts(mailboxId);
		expect(runSenderShortcut('archive', message)).toBe(false);
		expect(setStatus).not.toHaveBeenCalled();
	});
});
