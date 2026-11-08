/**
 * The Companies list: each company links to its page with its conversation
 * count, the search narrows it by name or domain, and an empty workspace
 * explains where companies come from.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import UiAvatar from '~/components/ui/Avatar.vue';
import UiSkeletonRow from '@owlat/ui/components/ui/SkeletonRow.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

vi.mock('@owlat/api', () => ({ api: { companies: { companies: { list: 'companies.list' } } } }));

const data = ref<unknown>(undefined);

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useConvexQuery', () => ({
		data,
		error: ref(null),
		isLoading: ref(false),
		refetch: vi.fn(),
	}));
});

beforeEach(() => {
	data.value = undefined;
});

async function mountPage() {
	const Page = (await import('../index.vue')).default;
	const wrapper = mount(Page, {
		global: { plugins: [createTestI18n()], components: { UiAvatar, UiSkeletonRow } },
	});
	await nextTick();
	return wrapper;
}

const COMPANIES = [
	{
		key: 'northwind.example',
		name: 'Northwind',
		conversations: 3,
		people: ['mia@northwind.example', 'jonas@northwind.example'],
		peopleCount: 6,
		lastMessageAt: Date.UTC(2026, 9, 2),
	},
	{
		key: 'contoso.example',
		name: 'Contoso',
		conversations: 1,
		people: ['ana@contoso.example'],
		peopleCount: 1,
		lastMessageAt: Date.UTC(2026, 9, 1),
	},
];

describe('Companies page', () => {
	it('lists each company with a link, its people and its conversations', async () => {
		data.value = COMPANIES;
		const w = await mountPage();
		const rows = w.findAll('[data-testid="company-row"]');
		expect(rows.map((row) => row.attributes('href'))).toEqual([
			'/dashboard/companies/northwind.example',
			'/dashboard/companies/contoso.example',
		]);
		expect(rows[0]!.text()).toContain('Northwind');
		expect(rows[0]!.text()).toContain('3 conversations');
		expect(rows[0]!.text()).toContain('+4');
		expect(rows[0]!.text()).toContain('6 people');
		expect(rows[1]!.text()).toContain('1 conversation');
		expectFullyLocalized(w);
	});

	it('narrows the list by name or domain, and says when nothing matches', async () => {
		data.value = COMPANIES;
		const w = await mountPage();
		await w.get('[data-testid="companies-search"]').setValue('contoso.ex');
		expect(w.findAll('[data-testid="company-row"]')).toHaveLength(1);
		await w.get('[data-testid="companies-search"]').setValue('fabrikam');
		expect(w.find('[data-testid="companies-list"]').exists()).toBe(false);
		expect(w.text()).toContain('No company matches “fabrikam”');
	});

	it('explains where companies come from when there are none', async () => {
		data.value = [];
		const w = await mountPage();
		const empty = w.get('[data-testid="companies-empty"]');
		expect(empty.text()).toContain('No companies yet');
		expect(empty.text()).toContain("Free-mail addresses like Gmail aren't grouped");
		expect(w.find('[data-testid="companies-search"]').exists()).toBe(false);
	});
});
