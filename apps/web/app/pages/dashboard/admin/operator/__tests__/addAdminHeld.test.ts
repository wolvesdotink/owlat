/**
 * With every member already a platform admin, Add admin is held: it stays
 * focusable, its tooltip says why (on keyboard focus too), and pressing it
 * opens nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { focusTooltip, tooltipOf } from '~/__tests__/tooltip';
import { formatRelativeTime } from '~/utils/formatters';
import { abuseStatusVariant, riskLevelVariant, scanLevelVariant } from '~/utils/operatorConsole';
import UiTabs from '@owlat/ui/components/ui/Tabs.vue';
import OperatorPage from '../index.vue';

const LIST_ADMINS = getFunctionName(api.platformAdmin.queries.listPlatformAdmins);
const LIST_USERS = getFunctionName(api.platformAdmin.queries.listAllUsers);

const ada = { authUserId: 'user_ada', email: 'ada@owlat.example', name: 'Ada' };
const lin = { authUserId: 'user_lin', email: 'lin@owlat.example', name: 'Lin' };
const users = ref([ada]);

beforeEach(() => {
	users.value = [ada];
	installNuxtStubs({
		...i18nStubs,
		useToast: () => ({ showToast: vi.fn() }),
		useConvexQuery: (fn: Parameters<typeof getFunctionName>[0]) => {
			const name = getFunctionName(fn);
			if (name === LIST_ADMINS)
				return queryResult([
					{
						_id: 'pa_1',
						authUserId: ada.authUserId,
						email: ada.email,
						role: 'superadmin',
						createdAt: 0,
					},
				]);
			if (name === LIST_USERS) return { ...queryResult(undefined), data: users };
			return queryResult(undefined);
		},
		useBackendOperation: () => ({ run: vi.fn(), isLoading: ref(false), error: ref(null) }),
	});
});

async function mountAdminsTab() {
	const wrapper = mount(OperatorPage, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: { UiTabs },
			// Template auto-imports; the test build does not rewrite templates.
			mocks: { abuseStatusVariant, riskLevelVariant, scanLevelVariant, formatRelativeTime },
			stubs: {
				UiBadge: { template: '<span><slot /></span>' },
				UiIconBox: true,
				UiEmptyState: true,
				UiSelect: true,
				UiTextarea: true,
				UiModal: {
					name: 'UiModal',
					props: ['open'],
					template: '<div v-if="open" data-testid="modal"><slot /></div>',
				},
			},
		},
	});
	await flushPromises();
	const tab = wrapper.findAll('[role="tab"]').find((t) => t.text().startsWith('Admins'))!;
	await tab.trigger('click');
	await flushPromises();
	return wrapper;
}

const addAdmin = (wrapper: Awaited<ReturnType<typeof mountAdminsTab>>) =>
	wrapper.get('[data-testid="operator-add-admin"]');

describe('operator console Add admin', () => {
	it('is held, with its reason in a tooltip keyboard focus opens, when nobody is left to promote', async () => {
		const wrapper = await mountAdminsTab();
		const button = addAdmin(wrapper);

		expect(button.attributes('disabled')).toBeUndefined();
		expect(button.attributes('aria-disabled')).toBe('true');
		expect(button.attributes('title')).toBeUndefined();
		expect(tooltipOf(wrapper, button)).toBe('Every member already holds platform admin.');
		expect(await focusTooltip(button)).toBe('Every member already holds platform admin.');

		await button.trigger('click');
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(false);
		wrapper.unmount();
	});

	it('opens the add-admin dialog, with no tooltip, while someone can be promoted', async () => {
		users.value = [ada, lin];
		const wrapper = await mountAdminsTab();
		const button = addAdmin(wrapper);

		expect(button.attributes('aria-disabled')).toBeUndefined();
		expect(tooltipOf(wrapper, button)).toBeUndefined();

		await button.trigger('click');
		expect(wrapper.find('[data-testid="modal"]').exists()).toBe(true);
		wrapper.unmount();
	});
});
