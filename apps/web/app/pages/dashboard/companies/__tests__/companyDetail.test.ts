/**
 * One company's page: its conversations linked to where they open, the
 * colleague line naming only the colleague, the open tasks and the people; a
 * company the index does not know reads as an empty company, not an error.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref, watchEffect } from 'vue';
import UiAvatar from '~/components/ui/Avatar.vue';
import UiSkeletonRow from '@owlat/ui/components/ui/SkeletonRow.vue';
import UiBadge from '@owlat/ui/components/ui/Badge.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => ({
	api: {
		companies: { companies: { get: 'companies.get' } },
		tasks: { tasks: { forCompany: 'tasks.forCompany' } },
	},
}));

const members = ref([
	{ userId: 'u-taylor', user: { name: 'Taylor', email: 'taylor@owlat.example' } },
]);
vi.mock('~/composables/useOrganization', () => ({
	useOrganization: () => ({ members, fetchMembers: vi.fn() }),
}));
vi.mock('~/composables/useTaskActions', () => ({ useTaskActions: () => ({ setStatus: vi.fn() }) }));

const results: Record<string, ReturnType<typeof ref<unknown>>> = {
	'companies.get': ref<unknown>(undefined),
	'tasks.forCompany': ref<unknown>(undefined),
};
const queriedWith = vi.fn();
const routeKey = ref('northwind.example');

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useRoute', () => ({ params: { key: routeKey.value } }));
	vi.stubGlobal('useBreadcrumbs', () => ({
		setDynamicBreadcrumbs: vi.fn(),
		clearDynamicBreadcrumbs: vi.fn(),
	}));
	vi.stubGlobal('useConvexQuery', (fn: string, args: () => unknown) => {
		watchEffect(() => queriedWith(fn, args()));
		return { data: results[fn], error: ref(null), isLoading: ref(false), refetch: vi.fn() };
	});
});

beforeEach(() => {
	results['companies.get']!.value = undefined;
	results['tasks.forCompany']!.value = [];
	queriedWith.mockReset();
	routeKey.value = 'northwind.example';
});

const TasksTaskCreatePopover = defineComponent({
	name: 'TasksTaskCreatePopover',
	props: { companyKey: String, label: String, variant: String },
	setup: (props) => () => h('button', { 'data-company': props.companyKey }, props.label),
});

async function mountPage() {
	const Page = (await import('../[key].vue')).default;
	const wrapper = mount(Page, {
		global: {
			plugins: [createTestI18n()],
			components: { UiAvatar, UiSkeletonRow, UiBadge, TasksTaskCreatePopover },
		},
	});
	await nextTick();
	return wrapper;
}

describe('Company page', () => {
	it('leads with the open work, then the conversations and the people', async () => {
		routeKey.value = 'mail.northwind.example';
		results['companies.get']!.value = {
			key: 'northwind.example',
			name: 'Northwind',
			people: [
				{ address: 'mia@northwind.example', name: 'Mia Weber', conversations: 2, lastMessageAt: 2 },
			],
			conversations: [
				{
					kind: 'team',
					mailThreadId: null,
					messageId: null,
					conversationThreadId: 'ct1',
					mailboxId: null,
					mailboxName: null,
					subject: 'Order 42',
					snippet: null,
					addresses: ['mia@northwind.example'],
					lastMessageAt: Date.UTC(2026, 9, 2),
				},
			],
			colleagueUserIds: ['u-taylor'],
			lastMessageAt: Date.UTC(2026, 9, 2),
		};
		const w = await mountPage();

		expect(queriedWith).toHaveBeenCalledWith('companies.get', { key: 'northwind.example' });
		expect(queriedWith).toHaveBeenCalledWith('tasks.forCompany', {
			companyKey: 'northwind.example',
		});
		expect(w.get('h1').text()).toBe('Northwind');
		expect(w.get('[data-company="northwind.example"]').text()).toBe('Make task');
		expect(w.get('[data-testid="company-colleagues"]').text()).toBe(
			'Taylor is also in touch with Northwind.'
		);
		const conversation = w.get('[data-testid="company-conversation"]');
		expect(conversation.attributes('href')).toBe('/dashboard/inbox/ct1');
		expect(conversation.text()).toContain('Order 42');
		expect(conversation.text()).toContain('Mia Weber');
		expect(w.get('[data-testid="company-conversation-source"]').text()).toBe('Team Inbox');
		expect(w.get('[data-testid="company-no-tasks"]').exists()).toBe(true);
		// The open work leads; the conversations follow as its history.
		const sections = w.findAll('h2').map((el) => el.text().replace(/\s*\d+$/, ''));
		expect(sections).toEqual(['Open work', 'Conversations', 'People']);
		expect(w.get('[data-testid="company-people"] a').attributes('href')).toBe(
			'/dashboard/compose?to=mia%40northwind.example'
		);
		expectFullyLocalized(w);
	});

	it('reads a company the index does not know as an empty company', async () => {
		routeKey.value = 'fabrikam.example';
		results['companies.get']!.value = {
			key: 'fabrikam.example',
			name: 'Fabrikam',
			people: [],
			conversations: [],
			colleagueUserIds: [],
			lastMessageAt: null,
		};
		const w = await mountPage();
		const empty = w.get('[data-testid="company-empty"]');
		expect(empty.text()).toContain('Nothing with Fabrikam yet');
		expect(empty.text()).toContain('within a couple of minutes');
		expect(w.find('[role="alert"]').exists()).toBe(false);
	});
});
