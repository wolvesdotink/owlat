// @vitest-environment happy-dom
/**
 * Per-message reply in the Team Inbox's cross-channel timeline:
 *   - a channel message the instance can send on offers a Reply button, and
 *     replying goes out on THAT message's channel, to THAT message's contact,
 *     pinned to the thread being read
 *   - email never offers one (the draft composer above owns email)
 *   - neither does a channel that is not configured/enabled, nor a row with no
 *     contact to address
 *
 * The shared send path (`useChannelOutbound`) is mocked here, so `canSendOn`
 * standing in for the real gate is an assumption of these cases, not something
 * they prove. Its own admin gate, enabled-channel filter, chat-vs-provider
 * branch and argument shaping are exercised against the real composable in
 * `app/composables/__tests__/useChannelOutbound.test.ts`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const send = vi.fn().mockResolvedValue(true);
const canSendOn = vi.fn((channel: string) => channel === 'sms' || channel === 'chat');

vi.mock('~/composables/useChannelOutbound', () => ({
	useChannelOutbound: () => ({ isSending: ref(false), canSendOn, send }),
}));

const timelineRows = ref<Array<Record<string, unknown>>>([]);
vi.stubGlobal('useConvexQuery', () => ({ data: timelineRows, isLoading: ref(false) }));

const ThreadChannelTimeline = (await import('../ThreadChannelTimeline.vue')).default;

const THREAD_ID = 'thread_1';
const CONTACT_ID = 'contact_1';

/** Minimal v-model-capable textarea stand-in for the design-system component. */
const UiTextareaStub = defineComponent({
	props: { modelValue: { type: String, default: '' } },
	emits: ['update:modelValue'],
	setup(props, { emit }) {
		return () =>
			h('textarea', {
				value: props.modelValue,
				onInput: (event: Event) =>
					emit('update:modelValue', (event.target as HTMLTextAreaElement).value),
			});
	},
});

// Every visible string flows through vue-i18n now: mount with the real catalog
// and expose `useI18n`, which is a Nuxt auto-import in the app.
beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const mountOpts = {
	global: {
		plugins: [createTestI18n()],
		stubs: { Icon: true, UiBadge: true, UiSpinner: true },
		components: { UiTextarea: UiTextareaStub },
	},
	props: { threadId: THREAD_ID as never },
};

function message(over: Record<string, unknown> = {}) {
	return {
		_id: 'msg_1',
		channel: 'sms',
		direction: 'inbound',
		contactId: CONTACT_ID,
		content: { text: 'is my order shipped?' },
		status: 'received',
		createdAt: Date.now(),
		...over,
	};
}

function replyButtons(wrapper: ReturnType<typeof mount>) {
	return wrapper.findAll('button').filter((b) => b.text().includes('Reply'));
}

describe('ThreadChannelTimeline per-message reply', () => {
	beforeEach(() => {
		send.mockClear();
		timelineRows.value = [];
	});

	it('offers a reply on a sendable channel message', () => {
		timelineRows.value = [message()];
		const wrapper = mount(ThreadChannelTimeline, mountOpts);
		expect(replyButtons(wrapper)).toHaveLength(1);
	});

	it('never offers a reply on an email message', () => {
		timelineRows.value = [message({ _id: 'msg_email', channel: 'email' })];
		const wrapper = mount(ThreadChannelTimeline, mountOpts);
		expect(replyButtons(wrapper)).toHaveLength(0);
		expect(canSendOn).not.toHaveBeenCalledWith('email');
	});

	it('offers no reply on a channel that is not configured and enabled', () => {
		timelineRows.value = [message({ _id: 'msg_wa', channel: 'whatsapp' })];
		const wrapper = mount(ThreadChannelTimeline, mountOpts);
		expect(replyButtons(wrapper)).toHaveLength(0);
	});

	it('offers no reply on a provider message with no contact to address', () => {
		timelineRows.value = [message({ contactId: undefined })];
		const wrapper = mount(ThreadChannelTimeline, mountOpts);
		expect(replyButtons(wrapper)).toHaveLength(0);
	});

	it('sends on the replied-to message channel, pinned to this thread', async () => {
		timelineRows.value = [message()];
		const wrapper = mount(ThreadChannelTimeline, mountOpts);

		await replyButtons(wrapper)[0]!.trigger('click');
		await wrapper.find('textarea').setValue('yes, it shipped today');

		const sendButton = wrapper.findAll('button').find((b) => b.text().includes('Send'));
		await sendButton!.trigger('click');

		expect(send).toHaveBeenCalledWith({
			channel: 'sms',
			text: 'yes, it shipped today',
			contactId: CONTACT_ID,
			threadId: THREAD_ID,
		});
	});

	it('closes the composer once the send succeeds', async () => {
		timelineRows.value = [message()];
		const wrapper = mount(ThreadChannelTimeline, mountOpts);

		await replyButtons(wrapper)[0]!.trigger('click');
		await wrapper.find('textarea').setValue('on its way');
		await wrapper
			.findAll('button')
			.find((b) => b.text().includes('Send'))!
			.trigger('click');
		await wrapper.vm.$nextTick();

		expect(wrapper.find('textarea').exists()).toBe(false);
		expect(replyButtons(wrapper)).toHaveLength(1);
	});
});
