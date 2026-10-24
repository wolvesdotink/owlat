/**
 * The sidebar row's context menu: Open, the verbs the row's group supplies,
 * then the link verbs. The Team inbox group supplies its own triage verbs
 * (assign to me, resolve), each undoable back to what the row showed when the
 * menu opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { inject, ref } from 'vue';
import { createTestI18n } from '~/__tests__/i18n';
import { useConvexQuery } from '~/composables/useConvexQuery';
import { usePostboxTriageUndo } from '~/composables/postbox/usePostboxTriageUndo';
import ShellThreadRow from '../ThreadRow.vue';
import TeamInboxGroup from '../TeamInboxGroup.vue';

const i18n = createTestI18n();
const navigateTo = vi.fn();
const writes: Array<[string, Record<string, unknown>]> = [];
let toasts: Array<{ message: string; action?: { onAction: () => void } }>;
let deliveries: Array<(value: unknown) => void>;

beforeEach(() => {
	writes.length = 0;
	toasts = [];
	deliveries = [];
	navigateTo.mockClear();
	const buckets = new Map<string, unknown>();
	Object.assign(globalThis, {
		// The global composer, so the undo module reads the catalog in teardown too.
		useI18n: () => i18n.global,
		inject,
		navigateTo,
		useRoute: () => ({ path: '/dashboard' }),
		useConvex: () => ({
			onUpdate: (_q: unknown, _a: unknown, deliver: (value: unknown) => void) => {
				deliveries.push(deliver);
				return () => {};
			},
		}),
		useConvexQuery,
		useAuth: () => ({ user: ref({ id: 'user1' }) }),
		useBackendOperation: (_op: unknown, opts: { label: () => string }) => ({
			isLoading: ref(false),
			run: async (args: Record<string, unknown>) => {
				writes.push([opts.label(), args]);
				return { ok: true, result: { success: true } };
			},
		}),
		useState: (key: string, init: () => unknown) => {
			if (!buckets.has(key)) buckets.set(key, ref(init()));
			return buckets.get(key);
		},
		useToast: () => ({
			showToast: (
				message: string,
				_type: string,
				options?: { action?: { onAction: () => void } }
			) => {
				toasts.push({ message, ...(options?.action ? { action: options.action } : {}) });
				return `t${toasts.length}`;
			},
			removeToast: vi.fn(),
			updateToast: vi.fn(),
			setToastShortcutHint: vi.fn(),
		}),
	});
});

afterEach(() => {
	usePostboxTriageUndo().dismiss();
});

const global = {
	plugins: [i18n],
	components: {
		ShellThreadRow,
		NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
		ShellStatusPill: { props: ['status'], template: '<span />' },
	},
	stubs: { Icon: true },
	mocks: { formatCompactRelativeTime: () => 'now' },
};

const labels = () =>
	Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
		(el) => el.querySelector('span')!.textContent
	);
const pick = (label: string) =>
	Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
		.find((el) => el.querySelector('span')!.textContent === label)!
		.click();

describe('ShellThreadRow menu', () => {
	it('opens the row, with the link verbs, and the group’s verbs between', async () => {
		const own = vi.fn();
		const wrapper = mount(ShellThreadRow, {
			props: {
				to: '/dashboard/chat/room_1',
				jumpKey: 'chat:room_1',
				title: '# general',
				menuItems: () => [{ id: 'own', label: 'Mark read', run: own }],
			},
			global,
			attachTo: document.body,
		});
		await wrapper.get('a').trigger('contextmenu', { clientX: 5, clientY: 5 });
		expect(labels()).toEqual(['Open', 'Mark read', 'Open in new tab', 'Copy link']);
		pick('Open');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/chat/room_1');
		wrapper.unmount();
	});
});

describe('Team inbox group row menu', () => {
	it('assigns to me and resolves, each undoable to the prior state', async () => {
		const wrapper = mount(TeamInboxGroup, {
			props: { limit: 5, sort: 'recent', collapsed: false },
			global,
			attachTo: document.body,
		});
		// The first subscription is the thread list.
		deliveries[0]!({
			threads: [
				{
					_id: 'th_1',
					subject: 'Refund',
					lastMessageAt: 1,
					unread: false,
					status: 'waiting',
					assignedTo: 'user2',
				},
			],
		});
		await flushPromises();
		const row = wrapper.get('[data-sidebar-jump="team:th_1"]');

		await row.trigger('contextmenu', { clientX: 5, clientY: 5 });
		expect(labels()).toEqual(['Open', 'Assign to me', 'Resolve', 'Open in new tab', 'Copy link']);
		pick('Resolve');
		await flushPromises();
		await row.trigger('contextmenu', { clientX: 5, clientY: 5 });
		pick('Assign to me');
		await flushPromises();
		expect(writes).toEqual([
			['Update thread status', { threadId: 'th_1', status: 'resolved' }],
			['Assign thread', { threadId: 'th_1', assignedTo: 'user1' }],
		]);

		writes.length = 0;
		for (const toast of [...toasts].reverse()) toast.action?.onAction();
		await flushPromises();
		expect(writes).toEqual([
			['Assign thread', { threadId: 'th_1', assignedTo: 'user2' }],
			['Update thread status', { threadId: 'th_1', status: 'waiting' }],
		]);
		wrapper.unmount();
	});
});
