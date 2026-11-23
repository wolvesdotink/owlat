/**
 * The suppressions list reads its reason filter from the URL, so the delivery
 * hub's bounce and complaint checks can open it on the addresses they count:
 * `?reason=bounced` lists the bounced ones. An unknown reason lists everything.
 * Picking a reason writes the URL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useFormModal } from '~/composables/useFormModal';
import Suppressions from '../suppressions.vue';

const route = reactive<{ path: string; query: Record<string, string | undefined> }>({
	path: '/dashboard/audience/suppressions',
	query: {},
});
const replace = vi.fn();
let listArgs: () => unknown = () => undefined;

beforeEach(() => {
	route.query = {};
	replace.mockClear();
	installNuxtStubs({
		...i18nStubs,
		useRoute: () => route,
		useRouter: () => ({ replace, push: vi.fn() }),
		useOrganizationQuery: (reference: FunctionReference<'query'>, args?: () => unknown) => {
			if (getFunctionName(reference) === 'blockedEmails/blocklist:listByTeam') {
				listArgs = args ?? (() => undefined);
				return queryResult([]);
			}
			return queryResult(undefined);
		},
		useFormModal,
		useDebouncedSearch: () => ({ searchQuery: ref(''), debouncedSearch: ref('') }),
		useBlocklistImport: () => ({ open: vi.fn(), startImport: vi.fn() }),
	});
});

async function mountPage() {
	const wrapper = mount(Suppressions, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				AudienceTabs: true,
				UiPageHeader: { template: '<div><slot name="actions" /></div>' },
				UiQueryBoundary: { template: '<div><slot /></div>' },
				UiEmptyState: true,
				UiDisclosure: true,
				UiButton: true,
				UiModal: true,
				UiInput: true,
				UiConfirmationDialog: true,
				ContactsSunsetClockBanner: true,
				AudienceSuppressionsTable: true,
				AudienceSuppressionSunsetControls: true,
				AudienceSuppressionsImportModal: true,
			},
		},
	});
	await flushPromises();
	return wrapper;
}

describe('suppressions reason filter', () => {
	it.each([
		[undefined, undefined, 'all'],
		['bounced', 'bounced', 'bounced'],
		['complained', 'complained', 'complained'],
		['nonsense', undefined, 'all'],
	] as const)('?reason=%s lists the matching suppressions', async (reason, expected, selected) => {
		route.query = { reason };
		const wrapper = await mountPage();
		expect(listArgs()).toEqual({ reason: expected });
		expect((wrapper.get('select').element as HTMLSelectElement).value).toBe(selected);
	});

	it('writes the picked reason to the URL and drops it for all', async () => {
		route.query = { tab: 'x' };
		const wrapper = await mountPage();
		await wrapper.get('select').setValue('bounced');
		expect(replace).toHaveBeenLastCalledWith({ query: { tab: 'x', reason: 'bounced' } });
		await wrapper.get('select').setValue('all');
		expect(replace).toHaveBeenLastCalledWith({ query: { tab: 'x', reason: undefined } });
	});
});
