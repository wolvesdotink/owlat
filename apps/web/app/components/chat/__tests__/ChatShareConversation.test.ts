/**
 * "Share in chat…" through `ChatLinkEmailDialog`: opened from a conversation it
 * lists only rooms a post can land in, sends the link once to the chosen one,
 * and stays open when the send is refused. Opened from a room it is still the
 * thread picker it always was, and neither mode reads the other's data.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref, type Ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { getFunctionName } from 'convex/server';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import ChatLinkEmailDialog from '../ChatLinkEmailDialog.vue';
import ChatShareConversationPicker from '../ChatShareConversationPicker.vue';

const showToast = vi.fn();
let sendOutcome: () => Promise<{ ok: boolean }>;
let sends: Array<{ name: string; args: Record<string, unknown> }>;
let queried: string[];
let roomChannels: Ref<Array<ReturnType<typeof channel>>>;
let roomDms: Ref<Array<{ _id: string; displayName: string }>>;
let roomsError: Ref<Error | null>;
const refetchRooms = vi.fn();

const channel = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
	_id: id,
	displayName: name,
	visibility: 'public',
	isMember: true,
	...extra,
});

beforeEach(() => {
	showToast.mockClear();
	sends = [];
	queried = [];
	sendOutcome = async () => ({ ok: true });
	refetchRooms.mockClear();
	roomChannels = ref([
		channel('c1', 'support'),
		channel('c2', 'leadership', { visibility: 'private' }),
		channel('c3', 'random', { isMember: false }),
	]);
	roomDms = ref([{ _id: 'd1', displayName: 'Inés Okafor' }]);
	roomsError = ref<Error | null>(null);
	installNuxtStubs({
		...i18nStubs,
		useToast: () => ({ showToast }),
		useChatRooms: () => ({
			channels: roomChannels,
			dms: roomDms,
			isLoading: ref(false),
			error: roomsError,
			refetch: refetchRooms,
		}),
		useBackendOperation: (reference: unknown) => ({
			run: (args: Record<string, unknown>) => {
				sends.push({ name: getFunctionName(reference as never), args });
				return sendOutcome();
			},
		}),
		useChatActions: () => ({ linkChannelToInboxThread: vi.fn(), unlinkChannel: vi.fn() }),
		useDebouncedSearch: () => ({ query: ref(''), debouncedQuery: ref('') }),
		useConvexQuery: (reference: unknown, args: () => unknown) => {
			const resolved = computed(() => args());
			if (resolved.value !== 'skip') queried.push(getFunctionName(reference as never));
			return { data: ref({ threads: [] }), isLoading: ref(false) };
		},
	});
});

const mounted: VueWrapper[] = [];
afterEach(() => {
	while (mounted.length) mounted.pop()!.unmount();
});

const stubs = {
	UiSpinner: true,
	ChatDialogShell: {
		props: ['title'],
		emits: ['close'],
		template: '<section :data-title="title"><slot /></section>',
	},
	ChatShareConversationPicker,
	UiQueryBoundary: {
		props: ['error'],
		emits: ['retry'],
		template:
			'<div data-testid="rooms-error"><button data-testid="rooms-retry" @click="$emit(\'retry\')" /></div>',
	},
	UiButton: {
		props: ['disabled', 'loading', 'variant', 'size'],
		emits: ['click'],
		template: '<button :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>',
	},
};

function mountShare(audience: 'personal' | 'shared' | 'team' = 'shared') {
	const wrapper = mount(ChatLinkEmailDialog, {
		props: {
			conversation: { kind: 'postbox', messageId: 'm1', mailboxId: 'mb1', folder: 'inbox' },
			audience,
		},
		global: { plugins: [createTestI18n()], stubs },
	});
	mounted.push(wrapper);
	return wrapper;
}

const roomLabels = (wrapper: VueWrapper) =>
	wrapper.findAll('[data-testid^="share-room-"]').map((row) => row.text());
const sendButton = (wrapper: VueWrapper) => wrapper.get('[data-testid="share-send"]');

describe('ChatLinkEmailDialog, opened from a conversation', () => {
	it('lists the channels you have joined and your DMs, and reads no Team Inbox threads', () => {
		const wrapper = mountShare();
		expect(wrapper.get('section').attributes('data-title')).toBe('Share in chat');
		expect(roomLabels(wrapper)).toEqual(['#support', '#leadership', 'Inés Okafor']);
		expect(queried).toEqual([]);
	});

	it('sends the link once to the chosen room, with the note above it, and closes', async () => {
		let settle!: (outcome: { ok: boolean }) => void;
		sendOutcome = () => new Promise((resolve) => (settle = resolve));
		const wrapper = mountShare();
		expect(sendButton(wrapper).attributes('disabled')).toBeDefined();
		await wrapper.get('[data-testid="share-room-c2"]').trigger('click');
		expect(wrapper.get('[data-testid="share-room-c2"]').attributes('aria-pressed')).toBe('true');
		await wrapper.get('textarea').setValue('  Can billing look at this?  ');
		await sendButton(wrapper).trigger('click');
		// A second press while the first send is in flight sends nothing.
		await sendButton(wrapper).trigger('click');
		settle({ ok: true });
		await flushPromises();

		expect(sends).toEqual([
			{
				name: 'chat/messages:sendMessage',
				args: {
					roomId: 'c2',
					text: `Can billing look at this?\n\n${window.location.origin}/dashboard/postbox/inbox/m1?mailbox=mb1`,
				},
			},
		]);
		expect(showToast).toHaveBeenCalledWith('Link shared in #leadership');
		expect(wrapper.emitted('close')).toHaveLength(1);
	});

	it('posts the bare link when there is no note', async () => {
		const wrapper = mountShare();
		await wrapper.get('[data-testid="share-room-d1"]').trigger('click');
		await sendButton(wrapper).trigger('click');
		await flushPromises();
		expect(sends[0]!.args['text']).toBe(
			`${window.location.origin}/dashboard/postbox/inbox/m1?mailbox=mb1`
		);
	});

	it('stays open with the room and the note when the send is refused', async () => {
		sendOutcome = async () => ({ ok: false });
		const wrapper = mountShare();
		await wrapper.get('[data-testid="share-room-c1"]').trigger('click');
		await wrapper.get('textarea').setValue('Look');
		await sendButton(wrapper).trigger('click');
		await flushPromises();
		expect(sends).toHaveLength(1);
		expect(wrapper.emitted('close')).toBeUndefined();
		expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('Look');
		expect(sendButton(wrapper).attributes('disabled')).toBeUndefined();
	});

	it('narrows the rooms by name', async () => {
		const wrapper = mountShare();
		await wrapper.get('input').setValue('SUP');
		expect(roomLabels(wrapper)).toEqual(['#support']);
	});

	it('offers a retry, not "nowhere to post", when the room reads fail, and keeps the note', async () => {
		const wrapper = mountShare();
		await wrapper.get('textarea').setValue('For the billing team');
		roomChannels.value = [];
		roomDms.value = [];
		roomsError.value = new Error('read failed');
		await flushPromises();

		expect(wrapper.find('[data-testid="rooms-error"]').exists()).toBe(true);
		expect(wrapper.text()).not.toContain('No channel or direct message to post in.');
		await wrapper.get('[data-testid="rooms-retry"]').trigger('click');
		expect(refetchRooms).toHaveBeenCalledTimes(1);

		roomsError.value = null;
		roomDms.value = [{ _id: 'd1', displayName: 'Inés Okafor' }];
		await flushPromises();
		expect(roomLabels(wrapper)).toEqual(['Inés Okafor']);
		expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe(
			'For the billing team'
		);
	});

	it('says the list is partial when one of the room reads fails, and retries it', async () => {
		const wrapper = mountShare();
		roomDms.value = [];
		roomsError.value = new Error('read failed');
		await flushPromises();

		expect(wrapper.find('[data-testid="rooms-error"]').exists()).toBe(false);
		expect(roomLabels(wrapper)).toEqual(['#support', '#leadership']);
		const notice = wrapper.get('[data-testid="share-rooms-partial"]');
		expect(notice.text()).toContain('Some channels or direct messages could not be loaded.');
		await notice.get('button').trigger('click');
		expect(refetchRooms).toHaveBeenCalledTimes(1);
	});

	it('disables Share when the chosen room drops out of the list', async () => {
		const wrapper = mountShare();
		await wrapper.get('[data-testid="share-room-c2"]').trigger('click');
		expect(sendButton(wrapper).attributes('disabled')).toBeUndefined();

		// Archived, or you left it, while the dialog was open.
		roomChannels.value = roomChannels.value.filter((room) => room._id !== 'c2');
		await flushPromises();
		expect(sendButton(wrapper).attributes('disabled')).toBeDefined();
		await sendButton(wrapper).trigger('click');
		await flushPromises();
		expect(sends).toEqual([]);
	});

	it('says who can open the link', () => {
		expect(mountShare('personal').get('[data-testid="share-audience"]').text()).toContain(
			'personal inbox'
		);
		expect(mountShare('shared').get('[data-testid="share-audience"]').text()).toContain(
			'Members of this inbox'
		);
		expect(mountShare('team').get('[data-testid="share-audience"]').text()).toContain(
			'Owners and admins'
		);
	});
});

describe('ChatLinkEmailDialog, opened from a room', () => {
	it('is still the Team Inbox thread picker', () => {
		const wrapper = mount(ChatLinkEmailDialog, {
			props: { roomId: 'r1' as never },
			global: { plugins: [createTestI18n()], stubs },
		});
		mounted.push(wrapper);
		expect(wrapper.get('section').attributes('data-title')).toBe('Link an email thread');
		expect(queried).toEqual(['inbox/queries:listThreads']);
		expect(wrapper.find('[data-testid="share-send"]').exists()).toBe(false);
	});
});
