/**
 * Which way a composer send goes. A reply takes the "after replying" setting:
 * Send and Cmd/Ctrl+Enter do what it says, Cmd/Ctrl+Alt+Enter the opposite, a
 * Send menu entry exactly what it names, and a scheduled reply the setting. A
 * new message or a forward carries no action and offers no menu. The keys go
 * through the real key handler, so the chord itself is under test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { usePostboxComposerKeys } from '../usePostboxComposerKeys';
import { usePostboxComposerSendChoice } from '../usePostboxComposerSendChoice';
import type { PostboxAfterReply } from '~/utils/postboxAfterReply';

const afterReply = ref<PostboxAfterReply>('keep');

beforeEach(() => {
	afterReply.value = 'keep';
	Object.assign(globalThis, {
		useI18n: () => ({ t: (key: string) => key }),
		useDesktopContext: () => ({ platform: ref('linux') }),
		usePostboxSettings: () => ({ afterReply }),
		usePostboxComposerKeys,
	});
});

function setup(seed: { inReplyToMessageId?: string } = { inReplyToMessageId: 'msg_1' }) {
	const send = vi.fn();
	const scheduleOpen = ref(false);
	const choice = usePostboxComposerSendChoice({
		seed: () => ({ mailboxId: 'mbx_1' as never, ...seed }) as never,
		rootEl: ref(document.createElement('div')),
		canSend: ref(true),
		sending: ref(false),
		isScheduled: ref(false),
		scheduleOpen,
		send,
		onMinimize: vi.fn(),
	});
	return { ...choice, send, scheduleOpen };
}

const enter = (mods: { alt?: boolean; shift?: boolean } = {}) =>
	new KeyboardEvent('keydown', {
		key: 'Enter',
		ctrlKey: true,
		altKey: mods.alt === true,
		shiftKey: mods.shift === true,
		cancelable: true,
	});

describe('usePostboxComposerSendChoice', () => {
	it.each([
		['keep', 'keep', 'done'],
		['done', 'done', 'keep'],
	] as const)(
		'with the setting on %s, Ctrl+Enter sends %s and Ctrl+Alt+Enter %s',
		(setting, plain, opposite) => {
			afterReply.value = setting;
			const { onComposerKeydown, send } = setup();
			onComposerKeydown(enter());
			expect(send).toHaveBeenLastCalledWith({ afterSend: plain });
			onComposerKeydown(enter({ alt: true }));
			expect(send).toHaveBeenLastCalledWith({ afterSend: opposite });
		}
	);

	it('sends a Send menu entry exactly as named, whatever the setting', () => {
		afterReply.value = 'done';
		const { sendWith, send } = setup();
		sendWith('keep');
		expect(send).toHaveBeenLastCalledWith({ afterSend: 'keep' });
		sendWith();
		expect(send).toHaveBeenLastCalledWith({ afterSend: 'done' });
	});

	it('opens the schedule dialog on Ctrl+Shift+Enter, and a scheduled reply takes the setting', () => {
		afterReply.value = 'done';
		const { onComposerKeydown, scheduleAt, send, scheduleOpen } = setup();
		onComposerKeydown(enter({ shift: true }));
		expect(scheduleOpen.value).toBe(true);
		expect(send).not.toHaveBeenCalled();
		scheduleAt(1_000);
		expect(send).toHaveBeenLastCalledWith({ scheduledSendAt: 1_000, afterSend: 'done' });
	});

	it('names both ways for the Send menu, with the chord that takes each', () => {
		afterReply.value = 'done';
		const { footerSend } = setup();
		expect(footerSend.value.sendActions).toEqual({
			primary: 'done',
			chords: { done: 'Ctrl+Enter', keep: 'Ctrl+Alt+Enter' },
			aria: { done: 'Control+Enter', keep: 'Control+Alt+Enter' },
		});
		afterReply.value = 'keep';
		expect(footerSend.value.sendActions?.chords).toEqual({
			keep: 'Ctrl+Enter',
			done: 'Ctrl+Alt+Enter',
		});
	});

	it('gives a new message or a forward no action and no menu', () => {
		afterReply.value = 'done';
		const { onComposerKeydown, sendWith, footerSend, send } = setup({});
		onComposerKeydown(enter());
		onComposerKeydown(enter({ alt: true }));
		sendWith();
		expect(send.mock.calls).toEqual([[{}], [{}], [{}]]);
		expect(footerSend.value.sendActions).toBeUndefined();
	});
});
