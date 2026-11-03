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
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useComposerDrafts } from '~/composables/useComposerDrafts';

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
		stubs: { UiBadge: true, UiSpinner: true },
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
		useComposerDrafts().bindUser(null);
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

	it('reopens an unsent reply where it was left, and Cancel lets it go', async () => {
		timelineRows.value = [message()];
		const first = mount(ThreadChannelTimeline, mountOpts);
		await replyButtons(first)[0]!.trigger('click');
		await first.find('textarea').setValue('checking with the courier');
		first.unmount();

		const again = mount(ThreadChannelTimeline, mountOpts);
		expect((again.find('textarea').element as HTMLTextAreaElement).value).toBe(
			'checking with the courier'
		);
		await again
			.findAll('button')
			.find((b) => b.text().includes('Cancel'))!
			.trigger('click');
		expect(again.find('textarea').exists()).toBe(false);
		expect(useComposerDrafts().get('channel-reply', THREAD_ID)).toBeNull();
	});

	it('keeps the reply when the send fails', async () => {
		send.mockResolvedValueOnce(false);
		timelineRows.value = [message()];
		const wrapper = mount(ThreadChannelTimeline, mountOpts);
		await replyButtons(wrapper)[0]!.trigger('click');
		await wrapper.find('textarea').setValue('try again later');
		await wrapper
			.findAll('button')
			.find((b) => b.text().includes('Send'))!
			.trigger('click');
		await flushPromises();
		expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('try again later');
	});

	it('says a large email mirrored as its excerpt is shortened (#900)', () => {
		timelineRows.value = [
			message({ channel: 'email', content: { text: 'The opening', isBodyTruncated: true } }),
			message({ _id: 'msg_2', channel: 'email', content: { text: 'A whole short email' } }),
		];
		const wrapper = mount(ThreadChannelTimeline, mountOpts);
		const note = 'Shortened: the full message is shown above.';
		expect(wrapper.text().split(note)).toHaveLength(2);
	});

	it('renders nothing on a thread no other channel has spoken on', () => {
		timelineRows.value = [];
		const wrapper = mount(ThreadChannelTimeline, mountOpts);
		expect(wrapper.find('[data-testid="thread-channel-timeline"]').exists()).toBe(false);
		expect(wrapper.text()).toBe('');
	});
});
