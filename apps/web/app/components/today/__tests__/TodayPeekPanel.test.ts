/**
 * The Workbench peek answers in Answer mode (plan §07): Reply on a Postbox
 * email opens `m/<messageId>`, Reply on a team message opens `t/<threadId>` on
 * that message, and a team update (which needs no reply until someone asks for
 * one) leaves the verb to the page's "Reply anyway".
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, reactive, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { TodaySource } from '~/utils/todayDigest';
import { useShortcutScope } from '~/composables/useShortcutScope';
import { useKeyboardShortcuts } from '~/composables/useKeyboardShortcuts';
import {
	applyShortcutPreferences,
	resetShortcutPreferences,
	resetShortcutScopes,
} from '~/utils/shortcutScope';
import TodayPeekPanel from '../TodayPeekPanel.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const open = vi.fn();
const openTeam = vi.fn();
vi.mock('~/composables/useAnswerMode', () => ({
	useAnswerModeNav: () => ({ open, openTeam }),
}));

const route = reactive({ query: {} as Record<string, string> });
const mailMessage = ref<unknown>(null);
const teamThread = ref<unknown>(null);

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useRoute: () => route,
		useInboxes: () => ({ byId: ref(new Map()) }),
		useBackendOperation: () => ({ run: vi.fn(async () => ({ ok: true })) }),
		useConvexQuery: (_q: unknown, args: () => unknown) => {
			const a = args();
			const isMail = !!a && typeof a === 'object' && 'messageId' in a;
			return {
				data: computed(() =>
					a === 'skip' ? undefined : isMail ? mailMessage.value : teamThread.value
				),
				isLoading: ref(false),
			};
		},
		formatCompactRelativeTime: () => 'now',
		useRouter: () => ({ push: vi.fn() }),
	});
});
beforeEach(() => {
	open.mockClear();
	openTeam.mockClear();
	mailMessage.value = null;
	teamThread.value = null;
	route.query = {};
	resetShortcutScopes();
	resetShortcutPreferences();
});

const teamSource: TodaySource = {
	kind: 'team',
	id: 'in_1',
	threadId: 'ct_1',
	mailboxId: null,
	fromName: 'Ana',
	fromAddress: 'ana@example.org',
	subject: 'Invoice',
	snippet: '',
	at: 1,
};

function mountPanel(sources: TodaySource[]) {
	return mount(TodayPeekPanel, {
		props: { sources },
		slots: {
			actions: `<template #actions="{ informational }"><span data-testid="slot" :data-informational="String(informational)" /></template>`,
		},
		global: {
			plugins: [createTestI18n()],
			mocks: { formatCompactRelativeTime: () => 'now' },
			stubs: { Icon: true, InboxChip: true, UiSkeleton: true, Transition: false },
		},
	});
}

describe('TodayPeekPanel replies in Answer mode', () => {
	it('Reply on a Postbox email opens Answer mode on that message', async () => {
		route.query = { peek: 'mail:msg_1' };
		mailMessage.value = {
			_id: 'msg_1',
			threadId: 'thr_1',
			mailboxId: 'mbx_1',
			fromAddress: 'jonas@example.com',
			fromName: 'Jonas',
			toAddresses: ['ada@example.com'],
			subject: 'September invoice',
			snippet: 'Could you send it?',
			receivedAt: 1,
			flagSeen: true,
			attachments: [],
		};
		const wrapper = mountPanel([]);
		await flushPromises();
		await wrapper.get('[data-testid="peek-reply"]').trigger('click');
		expect(open).toHaveBeenCalledWith('msg_1');
	});

	it('Reply on a team message opens Answer mode on its thread, answering that message', async () => {
		route.query = { peek: 'team:in_1' };
		teamThread.value = {
			messages: [
				{
					_id: 'in_1',
					subject: 'Invoice',
					from: 'ana@example.org',
					to: 'support@example.com',
					receivedAt: 1,
					textBody: 'Could you send it?',
					processingStatus: 'draft_ready',
				},
			],
		};
		const wrapper = mountPanel([teamSource]);
		await flushPromises();
		await wrapper.get('[data-testid="peek-reply"]').trigger('click');
		expect(openTeam).toHaveBeenCalledWith('ct_1', { messageId: 'in_1' });
		expect(wrapper.get('[data-testid="slot"]').attributes('data-informational')).toBe('false');
	});

	it('a team update offers no Reply of its own; the page shows "Reply anyway"', async () => {
		route.query = { peek: 'team:in_1' };
		teamThread.value = {
			messages: [
				{
					_id: 'in_1',
					subject: 'Newsletter',
					from: 'news@example.org',
					to: 'support@example.com',
					receivedAt: 1,
					textBody: 'FYI',
					processingStatus: 'informational',
				},
			],
		};
		const wrapper = mountPanel([teamSource]);
		await flushPromises();
		expect(wrapper.find('[data-testid="peek-reply"]').exists()).toBe(false);
		expect(wrapper.get('[data-testid="slot"]').attributes('data-informational')).toBe('true');
	});
});

describe('TodayPeekPanel keys', () => {
	const sources: TodaySource[] = [
		{ ...teamSource, id: 'in_1' },
		{ ...teamSource, id: 'in_2' },
		{ ...teamSource, id: 'in_3' },
	];

	function press(key: string) {
		const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
		document.body.dispatchEvent(event);
		return event;
	}

	/** The Workbench underneath, with its own `j`. */
	function mountWithWorkbench(onWorkbenchNext: () => void) {
		const Workbench = defineComponent({
			setup() {
				useShortcutScope('workbench');
				useKeyboardShortcuts().registerShortcut({ id: 'workbench.next', handler: onWorkbenchNext });
				return () => h(TodayPeekPanel, { sources, onStep: step, onClose: close });
			},
		});
		const step = vi.fn();
		const close = vi.fn();
		const wrapper = mount(Workbench, {
			attachTo: document.body,
			global: {
				plugins: [createTestI18n()],
				mocks: { formatCompactRelativeTime: () => 'now' },
				stubs: { Icon: true, InboxChip: true, UiSkeleton: true, Transition: false },
			},
		});
		return { wrapper, step, close };
	}

	// Open on load (a `?peek=` link): the panel mounts before the page hosting
	// it, and must still claim the keys above it.
	it('steps through the sources with j / k and the arrows, over the Workbench underneath', async () => {
		route.query = { peek: 'team:in_2' };
		const workbenchNext = vi.fn();
		const { step } = mountWithWorkbench(workbenchNext);
		await flushPromises();
		press('j');
		press('ArrowDown');
		press('k');
		press('ArrowUp');
		expect(step.mock.calls).toEqual([[2], [2], [0], [0]]);
		expect(workbenchNext).not.toHaveBeenCalled();
	});

	it('hands j back to the Workbench once it closes', async () => {
		route.query = { peek: 'team:in_2' };
		const workbenchNext = vi.fn();
		const { step } = mountWithWorkbench(workbenchNext);
		await flushPromises();
		route.query = {};
		await flushPromises();
		press('j');
		expect(step).not.toHaveBeenCalled();
		expect(workbenchNext).toHaveBeenCalledTimes(1);
	});

	it('follows a remap of its step keys', async () => {
		applyShortcutPreferences('owlat', [{ id: 'peek.next', keys: ['l'] }]);
		route.query = { peek: 'team:in_1' };
		const { step } = mountWithWorkbench(vi.fn());
		await flushPromises();
		press('j');
		press('l');
		expect(step.mock.calls).toEqual([[1]]);
	});

	it('closes on Escape through the shared Escape stack, but not from a text field', async () => {
		route.query = { peek: 'team:in_1' };
		const { close } = mountWithWorkbench(vi.fn());
		await flushPromises();
		const input = document.createElement('input');
		document.body.appendChild(input);
		input.focus();
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(close).not.toHaveBeenCalled();
		input.remove();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
		expect(close).toHaveBeenCalledTimes(1);
	});
});
