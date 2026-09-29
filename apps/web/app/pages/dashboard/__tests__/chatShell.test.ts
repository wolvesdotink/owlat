// @vitest-environment happy-dom
/**
 * The chat parent route (`pages/dashboard/chat.vue`) owns the rail and the
 * dialogs both chat pages reach. Before it existed, the empty state and the
 * room page each wired their own copy of the rail, its subscriptions and the
 * four shared dialogs, so the sidebar remounted on every move between them.
 * The children now open the rail and dialogs through `useChatShell()`.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import { createApp, defineComponent, h, nextTick, reactive, ref, type Component } from 'vue';

import { i18nStubs } from '~/__tests__/i18n';
import { mountDashboardPage } from '~/__tests__/a11y';
import { provideChatShell, useChatShell } from '~/composables/chat/useChatShell';
import { useRouteId } from '~/composables/useRouteId';
import ChatShellPage from '../chat.vue';
import ChatIndexPage from '../chat/index.vue';

const route = reactive<{ params: Record<string, string> }>({ params: {} });
const push = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useHead: () => {},
		definePageMeta: () => {},
		useRoute: () => route,
		useRouter: () => ({ push }),
		useRouteId,
		provideChatShell,
		useChatShell,
		useChatRooms: () => ({
			channels: ref([]),
			archivedChannels: ref([]),
			dms: ref([]),
			isLoading: ref(false),
		}),
		useChatMentions: () => ({ count: ref(2) }),
	});
});

/** Renders its name as a test id and its props as attributes. */
const marker = (name: string, emits: string[] = []) =>
	defineComponent({
		name,
		inheritAttrs: false,
		emits,
		setup:
			(_p, { attrs, slots }) =>
			() =>
				h('div', { 'data-testid': name, ...attrs }, slots.default?.()),
	});

const railDrawerStub = defineComponent({
	name: 'UiRailDrawer',
	props: { open: { type: Boolean, default: false } },
	setup:
		(props, { slots }) =>
		() =>
			h(
				'aside',
				{ 'data-testid': 'UiRailDrawer', 'data-open': String(props.open) },
				slots.default?.()
			),
});

let wrapper: VueWrapper | null = null;

function mountShell(child: Component) {
	wrapper = mountDashboardPage(ChatShellPage, {
		components: {
			NuxtPage: child,
			UiRailDrawer: railDrawerStub,
			ChatSidebar: marker('ChatSidebar'),
			ChatNewChannelDialog: marker('ChatNewChannelDialog', ['close', 'created']),
			ChatNewDmDialog: marker('ChatNewDmDialog', ['close', 'created']),
			ChatChannelBrowser: marker('ChatChannelBrowser', ['close']),
			ChatMentionsDialog: marker('ChatMentionsDialog', ['close']),
		},
	});
	return wrapper;
}

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	route.params = {};
	push.mockReset();
});

describe('chat parent route', () => {
	it('opens the new-channel dialog when a child calls useChatShell().openCreateChannel()', async () => {
		const child = defineComponent({
			setup() {
				const shell = useChatShell();
				return () =>
					h('button', { 'data-testid': 'child-new', onClick: shell.openCreateChannel }, 'new');
			},
		});
		const w = mountShell(child);
		expect(w.find('[data-testid="ChatNewChannelDialog"]').exists()).toBe(false);

		await w.get('[data-testid="child-new"]').trigger('click');

		expect(w.find('[data-testid="ChatNewChannelDialog"]').exists()).toBe(true);
	});

	it("wires the empty state's Browse and New channel buttons to the shared dialogs", async () => {
		const w = mountShell(ChatIndexPage);
		const buttons = w.findAll('button').filter((b) => /Browse channels|New channel/.test(b.text()));
		expect(buttons).toHaveLength(2);

		await buttons.find((b) => b.text().includes('Browse channels'))!.trigger('click');
		expect(w.find('[data-testid="ChatChannelBrowser"]').exists()).toBe(true);

		await buttons.find((b) => b.text().includes('New channel'))!.trigger('click');
		expect(w.find('[data-testid="ChatNewChannelDialog"]').exists()).toBe(true);
	});

	it('opens the rail from the child handle and closes it when the room changes', async () => {
		const w = mountShell(ChatIndexPage);
		const drawer = () => w.get('[data-testid="UiRailDrawer"]');
		const handle = w.get('button[aria-controls="chat-rail"]');
		expect(drawer().attributes('data-open')).toBe('false');
		expect(handle.attributes('aria-expanded')).toBe('false');

		await handle.trigger('click');
		expect(drawer().attributes('data-open')).toBe('true');
		expect(w.get('button[aria-controls="chat-rail"]').attributes('aria-expanded')).toBe('true');

		route.params = { roomId: 'room-2' };
		await nextTick();
		await nextTick();
		expect(drawer().attributes('data-open')).toBe('false');
	});

	it('passes the child route param to the sidebar as the active room', async () => {
		const w = mountShell(marker('Child'));
		const sidebar = () => w.getComponent({ name: 'ChatSidebar' });
		expect(sidebar().attributes('active-room-id')).toBeUndefined();
		expect(sidebar().attributes('mention-count')).toBe('2');

		route.params = { roomId: 'room-1' };
		await nextTick();
		expect(sidebar().attributes('active-room-id')).toBe('room-1');
	});

	it('navigates to a room created from the shared dialogs', async () => {
		const child = defineComponent({
			setup() {
				const shell = useChatShell();
				shell.openCreateChannel();
				return () => h('div');
			},
		});
		const w = mountShell(child);
		await nextTick();
		w.getComponent({ name: 'ChatNewChannelDialog' }).vm.$emit('created', 'room-9');
		await nextTick();

		expect(push).toHaveBeenCalledWith('/dashboard/chat/room-9');
		expect(w.find('[data-testid="ChatNewChannelDialog"]').exists()).toBe(false);
	});
});

describe('useChatShell', () => {
	it('throws a clear error outside the chat parent route', () => {
		expect(() => createApp({}).runWithContext(() => useChatShell())).toThrow(
			/needs the chat parent route/
		);
	});
});
