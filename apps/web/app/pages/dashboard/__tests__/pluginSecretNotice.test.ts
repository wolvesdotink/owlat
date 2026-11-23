/**
 * The plugin settings page lists each required secret whose deployment variable
 * is unset as "<env var> — <label>", with a space between the variable name and
 * the dash. Resetting the settings asks first, through a dialog that loads
 * after the page.
 */
import { describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import UiModal from '@owlat/ui/components/ui/Modal.vue';
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

function installPageStubs(run = vi.fn()) {
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
		useBackendOperation: () => ({ run, isLoading: ref(false) }),
		useToast: () => ({ showToast: vi.fn() }),
		// Inert: the real leave guard needs a router the page is not mounted under.
		useUnsavedChanges: () => ({
			showDialog: ref(false),
			isSavingBeforeLeave: ref(false),
			confirmDiscard: vi.fn(),
			confirmSave: vi.fn(),
			cancelNavigation: vi.fn(),
			setHasChanges: vi.fn(),
		}),
	});
}

describe('plugin settings page', () => {
	it('keeps a space between an unset secret’s variable and its label', async () => {
		installPageStubs();
		const { default: Page } = await import('../admin/instance/plugins/[id].vue');
		const wrapper = mountDashboardPage(Page, {
			stubs: {
				UiBadge: true,
				UiConfirmationDialog: true,
				UiSwitch: true,
				UiUnsavedChangesDialog: true,
			},
		});

		const row = wrapper
			.findAll('li')
			.find((li) => li.find('code').exists() && li.find('code').text() === 'PLUGIN_API_KEY');
		expect(row?.text()).toBe('PLUGIN_API_KEY — API key');
	});

	it('resets the settings only once the reset dialog is confirmed', async () => {
		const run = vi.fn(async () => ({ ok: true, result: { values: {}, secretsSet: {} } }));
		installPageStubs(run);
		const { default: Page } = await import('../admin/instance/plugins/[id].vue');
		const wrapper = mountDashboardPage(Page, {
			components: { UiButton, UiModal },
			stubs: { UiBadge: true, UiSwitch: true, UiUnsavedChangesDialog: true },
		});
		await vi.dynamicImportSettled();
		await flushPromises();

		const resetButton = wrapper.findAll('button').find((b) => b.text() === 'Reset to defaults');
		await resetButton!.trigger('click');
		await flushPromises();

		const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
		expect(dialog?.textContent).toContain('Reset plugin settings?');
		expect(dialog!.contains(document.activeElement)).toBe(true);
		expect(run).not.toHaveBeenCalled();

		const confirm = [...dialog!.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'Reset'
		);
		confirm!.click();
		await flushPromises();

		expect(run).toHaveBeenCalledWith({ pluginId: 'acme' });
		expect(document.body.querySelector('[role="dialog"]')).toBeNull();
		wrapper.unmount();
	});
});
