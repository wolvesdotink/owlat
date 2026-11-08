/**
 * The shell's undo-send host: a send leaves the page it was written on (the
 * compose page, Answer mode), so the countdown that can still take it back is
 * mounted by the shell, over whatever page comes next. The toast carries the
 * cancel mutation and the offline outbox, so it loads only once an undo-send
 * window opens, and stays mounted after. It also watches each reply waiting
 * to be confirmed sent, for as long as the shell is up.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import {
	clearReplyTaskHolds,
	holdTeamReplyOffer,
	useReplyTaskHolds,
} from '~/composables/useReplyTaskOffer';
import ComposerOverlay from '../ComposerOverlay.vue';

vi.mock('~/components/tasks/ReplyTaskOfferWatch.vue', () => ({
	__esModule: true,
	default: defineComponent({
		props: { hold: { type: Object, required: true } },
		setup: (props) => () =>
			h('i', { 'data-testid': 'reply-watch', 'data-key': (props.hold as { key: string }).key }),
	}),
}));

let undoSend: ReturnType<typeof ref<{ visible: boolean; sendAt: number }>>;

beforeEach(() => {
	undoSend = ref({ visible: false, sendAt: 0 });
	const states: Record<string, unknown> = { 'postbox:undo-send': undoSend };
	Object.assign(globalThis, {
		useState: (key: string, init: () => unknown) => (states[key] ??= ref(init())),
	});
});

function mountOverlay() {
	return mount(ComposerOverlay, {
		global: {
			stubs: {
				Teleport: true,
				LazyPostboxUndoSendToast: { template: '<div data-testid="toast" />' },
			},
		},
	});
}

const hasToast = (wrapper: ReturnType<typeof mountOverlay>) =>
	wrapper.find('[data-testid="toast"]').exists();

describe('ShellComposerOverlay', () => {
	it('leaves the toast unloaded until an undo-send window opens', async () => {
		const wrapper = mountOverlay();
		expect(hasToast(wrapper)).toBe(false);

		undoSend.value = { visible: true, sendAt: Date.now() + 10_000 };
		await nextTick();
		expect(hasToast(wrapper)).toBe(true);
	});

	it('keeps the toast mounted after the window closes, so it can transition out', async () => {
		undoSend.value = { visible: true, sendAt: Date.now() + 10_000 };
		const wrapper = mountOverlay();
		expect(hasToast(wrapper)).toBe(true);

		undoSend.value = { visible: false, sendAt: 0 };
		await nextTick();
		expect(hasToast(wrapper)).toBe(true);
	});

	it('watches each held reply while the shell is up, and drops them all with it', async () => {
		clearReplyTaskHolds();
		const wrapper = mountOverlay();
		holdTeamReplyOffer({ kind: 'reply', messageId: 'in_1' }, 'conv_1' as never);
		holdTeamReplyOffer({ kind: 'followUp', followUpId: 'fu_1' }, 'conv_1' as never);
		await flushPromises();
		expect(
			wrapper.findAll('[data-testid="reply-watch"]').map((w) => w.attributes('data-key'))
		).toEqual(['approve:in_1:now', 'followUp:fu_1']);

		wrapper.unmount();
		expect(useReplyTaskHolds().value).toEqual([]);
	});
});
