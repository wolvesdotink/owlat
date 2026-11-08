/**
 * The company context folded to one line for a narrow reader pane: the
 * company, how many open tasks, and the colleague presence line in its short
 * form, as a button that opens the whole panel in place. Nothing shows for a
 * conversation with no company and no tasks.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import CompanyContextDisclosure from '../CompanyContextDisclosure.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => ({
	api: {
		companies: { companies: { forThread: 'companies.forThread' } },
		tasks: { tasks: { forThread: 'tasks.forThread', forCompany: 'tasks.forCompany' } },
	},
}));

vi.mock('~/composables/useOrganization', () => ({
	useOrganization: () => ({
		members: ref([{ userId: 'u-taylor', user: { name: 'Taylor', email: 'taylor@owlat.example' } }]),
		fetchMembers: vi.fn(),
	}),
}));

vi.mock('../CompanyContextPanel.vue', () => ({
	default: defineComponent({
		name: 'CompanyContextPanel',
		props: { mailThreadId: { type: String, default: undefined } },
		setup: (props) => () => h('div', { 'data-testid': 'panel' }, props.mailThreadId),
	}),
}));

const results: Record<string, ReturnType<typeof ref<unknown>>> = {
	'companies.forThread': ref<unknown>([]),
	'tasks.forThread': ref<unknown>([]),
	'tasks.forCompany': ref<unknown>([]),
};

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useConvexQuery', (fn: string) => ({
		data: results[fn],
		error: ref(null),
		isLoading: ref(false),
		refetch: vi.fn(),
	}));
});

beforeEach(() => {
	for (const r of Object.values(results)) r.value = [];
});

const NORTHWIND = {
	key: 'northwind.example',
	name: 'Northwind',
	people: [],
	conversations: [],
	colleagueUserIds: ['u-taylor'],
	lastMessageAt: 1,
};
const task = (id: string, status = 'open') => ({ _id: id, title: id, status });

function mountLine() {
	return mount(CompanyContextDisclosure, {
		props: { mailThreadId: 'mt1' as never },
		global: { plugins: [createTestI18n()] },
	});
}

describe('CompanyContextDisclosure', () => {
	it('sums up the company, its open tasks and who else is in touch, and opens in place', async () => {
		results['companies.forThread']!.value = [NORTHWIND];
		results['tasks.forThread']!.value = [task('a'), task('b', 'done')];
		results['tasks.forCompany']!.value = [task('a'), task('c'), task('d')];
		const w = mountLine();
		await nextTick();

		const toggle = w.get('[data-testid="company-disclosure-toggle"]');
		expect(toggle.text()).toBe('Northwind · 3 open tasks · Taylor also in touch');
		expect(toggle.attributes('aria-expanded')).toBe('false');
		const panel = w.get(`[id="${toggle.attributes('aria-controls')}"]`);
		expect((panel.element as HTMLElement).style.display).toBe('none');

		await toggle.trigger('click');
		expect(toggle.attributes('aria-expanded')).toBe('true');
		expect((panel.element as HTMLElement).style.display).toBe('');
		expect(panel.get('[data-testid="panel"]').text()).toBe('mt1');
		expectFullyLocalized(w);
	});

	it('leaves out what it does not have', async () => {
		results['companies.forThread']!.value = [{ ...NORTHWIND, colleagueUserIds: [] }];
		const w = mountLine();
		await nextTick();
		expect(w.get('[data-testid="company-disclosure-toggle"]').text()).toBe('Northwind');
	});

	it('shows nothing with no company and no tasks', async () => {
		const w = mountLine();
		await nextTick();
		expect(w.find('[data-testid="company-disclosure"]').exists()).toBe(false);
	});
});
