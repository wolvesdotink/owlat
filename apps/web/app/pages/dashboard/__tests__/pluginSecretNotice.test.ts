// @vitest-environment happy-dom
/**
 * The plugin settings page lists each required secret whose deployment variable
 * is unset as "<env var> — <label>", with a space between the variable name and
 * the dash.
 */
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { installNuxtStubs, mountDashboardPage } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';

vi.mock('~/plugins/plugin-composition.generated', () => ({
	bundledPluginComposition: [
		{
			manifest: {
				id: 'acme',
				settingsSchema: [
					{
						kind: 'secret',
						key: 'apiKey',
						label: 'API key',
						envVar: 'PLUGIN_API_KEY',
						required: true,
					},
				],
			},
		},
	],
}));

describe('plugin settings page', () => {
	it('keeps a space between an unset secret’s variable and its label', async () => {
		installNuxtStubs({
			...i18nStubs,
			useRoute: () => ({ params: { id: 'acme' }, query: {}, path: '/', fullPath: '/' }),
			useConvexQuery: () => ({
				data: ref({
					plugins: [
						{
							pluginId: 'acme',
							packageName: '@acme/owlat-plugin',
							version: '1.0.0',
							enabled: true,
							capabilities: [],
							values: {},
							secretsSet: {},
						},
					],
					orphaned: [],
				}),
				isLoading: ref(false),
				error: ref(null),
				refetch: vi.fn(),
			}),
			useBackendOperation: () => ({ run: vi.fn(), isLoading: ref(false) }),
			useToast: () => ({ showToast: vi.fn() }),
		});
		const { default: Page } = await import('../admin/instance/plugins/[id].vue');
		const wrapper = mountDashboardPage(Page, {
			stubs: { UiBadge: true, UiConfirmationDialog: true, UiSwitch: true },
		});

		const row = wrapper
			.findAll('li')
			.find((li) => li.find('code').exists() && li.find('code').text() === 'PLUGIN_API_KEY');
		expect(row?.text()).toBe('PLUGIN_API_KEY — API key');
	});
});
