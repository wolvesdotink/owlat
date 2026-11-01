/**
 * The room page wires the composer's ↑ to the message list: the room's
 * `recallTarget` picks your last message for the signed-in user, and the list
 * opens that message's editor. Anything else goes back to the composer as is.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';

import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ChatRecallTarget } from '~/utils/composerRecall';
import RoomPage from '../[roomId].vue';

const openEditor = vi.fn();
let recallTarget: ReturnType<typeof vi.fn<(userId: string) => ChatRecallTarget>>;
let composerRecall: (() => ChatRecallTarget) | undefined;

const ListStub = defineComponent({
	setup(_props, { expose }) {
		expose({ openEditor });
		return () => h('div', { 'data-testid': 'list' });
	},
});
const InputStub = defineComponent({
	props: { recallLast: Function },
	setup(props) {
		composerRecall = props.recallLast as () => ChatRecallTarget;
		return () => h('div', { 'data-testid': 'input' });
	},
});

beforeEach(() => {
	openEditor.mockClear();
	composerRecall = undefined;
	recallTarget = vi.fn<(userId: string) => ChatRecallTarget>(() => ({
		kind: 'edit',
		messageId: 'msg_7',
	}));
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useHead: vi.fn(),
		definePageMeta: vi.fn(),
		useRouter: () => ({ push: vi.fn() }),
		useAuth: () => ({ user: ref({ id: 'user_me' }) }),
		useRouteId: () => ref('room_a'),
		useChatShell: () => ({ railOpen: ref(false), openRail: vi.fn() }),
		useChatActions: () => ({ archiveChannel: vi.fn(), unarchiveChannel: vi.fn() }),
		useChatRoom: () => ({
			room: ref({ _id: 'room_a', name: 'general', kind: 'channel', isMember: true }),
			roomLoading: ref(false),
			roomError: ref(null),
			refetchRoom: vi.fn(),
			messages: ref([]),
			messagesLoading: ref(false),
			messagesError: ref(null),
			refetchMessages: vi.fn(),
			hasMoreMessages: ref(false),
			loadMoreMessages: vi.fn(),
			atMaxMessages: ref(false),
			members: ref([]),
			linkedThread: ref(null),
			sendMessage: vi.fn(),
			editMessage: vi.fn(),
			deleteMessage: vi.fn(),
			recallTarget,
			joinChannel: vi.fn(),
			leaveRoom: vi.fn(),
		}),
	});
});

function mountPage() {
	return mount(RoomPage, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				ChatRoomHeader: true,
				ChatLinkedEmailPanel: true,
				ChatMemberList: true,
				ChatLinkEmailDialog: true,
				ChatEditChannelDialog: true,
				ChatRoomSkeleton: true,
				UiConfirmationDialog: true,
				UiQueryBoundary: true,
				AppErrorBoundary: { template: '<div><slot /></div>' },
				ChatMessageList: ListStub,
				ChatInput: InputStub,
			},
		},
	});
}

describe('chat room ↑ wiring', () => {
	it('opens the signed-in member’s last message in the list', async () => {
		mountPage();
		await flushPromises();
		expect(composerRecall?.()).toEqual({ kind: 'edit', messageId: 'msg_7' });
		expect(recallTarget).toHaveBeenCalledWith('user_me');
		expect(openEditor).toHaveBeenCalledWith('msg_7');
	});

	it('passes any other answer through without touching the list', async () => {
		recallTarget.mockReturnValue({ kind: 'notLoaded', canLoadEarlier: true });
		mountPage();
		await flushPromises();
		expect(composerRecall?.()).toEqual({ kind: 'notLoaded', canLoadEarlier: true });
		expect(openEditor).not.toHaveBeenCalled();
	});
});
