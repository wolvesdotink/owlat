/**
 * The company context beside a conversation: the company with its people, the
 * colleague line (names only), the earlier conversations linked to where they
 * open, and the conversation's tasks with Make task. A conversation without a
 * company keeps only the tasks block.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref, watchEffect } from 'vue';
import CompanyContextPanel from '../CompanyContextPanel.vue';
import UiAvatar from '~/components/ui/Avatar.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => ({
	api: {
		companies: { companies: { forThread: 'companies.forThread' } },
		tasks: { tasks: { forThread: 'tasks.forThread' }, mutations: { setStatus: 'tasks.setStatus' } },
	},
}));

const members = ref([
	{ userId: 'u-taylor', user: { name: 'Taylor', email: 'taylor@owlat.example' } },
]);
vi.mock('~/composables/useOrganization', () => ({
	useOrganization: () => ({ members, fetchMembers: vi.fn() }),
}));

const setStatus = vi.fn(async () => true);
vi.mock('~/composables/useTaskActions', () => ({ useTaskActions: () => ({ setStatus }) }));

const results: Record<string, ReturnType<typeof ref<unknown>>> = {
	'companies.forThread': ref<unknown>(undefined),
	'tasks.forThread': ref<unknown>(undefined),
};
const queriedWith = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useConvexQuery', (fn: string, args: () => unknown) => {
		watchEffect(() => queriedWith(fn, args()));
		return { data: results[fn], error: ref(null), isLoading: ref(false), refetch: vi.fn() };
	});
});

beforeEach(() => {
	results['companies.forThread']!.value = [];
	results['tasks.forThread']!.value = [];
	queriedWith.mockReset();
	setStatus.mockClear();
});

const popoverProps = vi.fn();
const TasksTaskCreatePopover = defineComponent({
	name: 'TasksTaskCreatePopover',
	inheritAttrs: false,
	setup(_props, { attrs }) {
		return () => {
			popoverProps({ ...attrs });
			return h('button', { 'data-testid': 'make-task' }, 'Make task');
		};
	},
});

function mountPanel(props: Record<string, unknown> = { mailThreadId: 'mt1' }) {
	return mount(CompanyContextPanel, {
		props: props as never,
		global: { plugins: [createTestI18n()], components: { UiAvatar, TasksTaskCreatePopover } },
	});
}

const NORTHWIND = {
	key: 'northwind.example',
	name: 'Northwind',
	people: [
		{ address: 'mia@northwind.example', name: 'Mia Weber', conversations: 2, lastMessageAt: 2 },
		{ address: 'jonas@northwind.example', name: null, conversations: 1, lastMessageAt: 1 },
	],
	conversations: [
		{
			kind: 'mail',
			mailThreadId: 'mt2',
			messageId: 'm9',
			conversationThreadId: null,
			mailboxId: 'mb1',
			mailboxName: 'Sales',
			subject: 'Framework agreement',
			snippet: null,
			addresses: ['mia@northwind.example'],
			lastMessageAt: Date.UTC(2026, 9, 1),
		},
		{
			kind: 'team',
			mailThreadId: null,
			messageId: null,
			conversationThreadId: 'ct1',
			mailboxId: null,
			mailboxName: null,
			subject: 'Order 42',
			snippet: null,
			addresses: ['jonas@northwind.example'],
			lastMessageAt: Date.UTC(2026, 9, 2),
		},
	],
	colleagueUserIds: ['u-taylor'],
	lastMessageAt: Date.UTC(2026, 9, 2),
};

const TASK = {
	_id: 'task1',
	title: 'Send the signed NDA',
	notes: null,
	visibility: 'private',
	groupId: null,
	groupName: null,
	createdBy: 'u-me',
	assigneeUserId: 'u-me',
	status: 'open',
	dueAt: null,
	companyKey: 'northwind.example',
	companyName: 'Northwind',
	source: null,
	completedAt: null,
	completedBy: null,
	createdAt: 1,
	updatedAt: 1,
};

describe('CompanyContextPanel', () => {
	it('shows the company, its people, the colleague and the earlier conversations', async () => {
		results['companies.forThread']!.value = [NORTHWIND];
		const w = mountPanel();
		await nextTick();

		expect(queriedWith).toHaveBeenCalledWith('companies.forThread', { mailThreadId: 'mt1' });
		expect(queriedWith).toHaveBeenCalledWith('tasks.forThread', { mailThreadId: 'mt1' });
		const text = w.text();
		expect(text).toContain('Northwind');
		expect(text).toContain('northwind.example');
		expect(text).toContain('Mia Weber');
		expect(text).toContain('jonas@northwind.example');
		expect(w.get('[data-testid="company-colleagues"]').text()).toBe(
			'Taylor is also in touch with Northwind.'
		);
		expect(text).toContain('Earlier with Northwind');
		expect(text).toContain('Team Inbox');
		expect(text).toContain('Sales');
		const hrefs = w.findAll('a').map((a) => a.attributes('href'));
		expect(hrefs).toEqual([
			'/dashboard/companies/northwind.example',
			'/dashboard/postbox/inbox/m9?mailbox=mb1',
			'/dashboard/inbox/ct1',
		]);
		expect(popoverProps).toHaveBeenLastCalledWith(
			expect.objectContaining({ 'mail-thread-id': 'mt1', 'company-key': 'northwind.example' })
		);
		expectFullyLocalized(w);
	});

	it('leaves the colleague line out when nobody else is in touch', async () => {
		results['companies.forThread']!.value = [{ ...NORTHWIND, colleagueUserIds: [] }];
		const w = mountPanel();
		await nextTick();
		expect(w.find('[data-testid="company-colleagues"]').exists()).toBe(false);
	});

	it('lists the conversation’s tasks, and ticking one finishes it', async () => {
		results['tasks.forThread']!.value = [TASK];
		const w = mountPanel({ conversationThreadId: 'ct9' });
		await nextTick();

		expect(queriedWith).toHaveBeenCalledWith('tasks.forThread', { conversationThreadId: 'ct9' });
		expect(w.get('[data-testid="company-task"]').text()).toContain('Send the signed NDA');
		expect(w.get('[data-testid="company-task-audience"]').text()).toBe('Private');
		expect(w.get('[data-testid="company-task"] a').attributes('href')).toBe(
			'/dashboard/tasks?task=task1'
		);
		const box = w.get('[data-testid="company-task"] input[type="checkbox"]');
		expect(box.attributes('aria-label')).toBe('Mark “Send the signed NDA” as done');
		(box.element as HTMLInputElement).checked = true;
		await box.trigger('change');
		expect(setStatus).toHaveBeenCalledWith(TASK, 'done');
	});

	it('keeps only the tasks block and Make task for a conversation without a company', async () => {
		const w = mountPanel();
		await nextTick();
		expect(w.find('[data-testid="company-context-company"]').exists()).toBe(false);
		expect(w.find('[data-testid="company-context-no-tasks"]').exists()).toBe(true);
		expect(w.find('[data-testid="make-task"]').exists()).toBe(true);
		expect(popoverProps).toHaveBeenLastCalledWith(
			expect.not.objectContaining({ 'company-key': expect.anything() })
		);
	});
});
