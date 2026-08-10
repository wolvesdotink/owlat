// @vitest-environment happy-dom
/**
 * The plugin settings page's save path.
 *
 * A secret is env-supplied and renders read-only, so a `required` secret whose
 * deployment variable is absent must NOT block the form: the page would
 * otherwise refuse to save every other setting while naming a field that has no
 * input. It is surfaced as a persistent warning instead.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

vi.mock('~/plugins/plugin-composition.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@example/slack-approvals',
			manifest: Object.freeze({
				id: 'slack-approvals',
				version: '1.0.0',
				capabilities: Object.freeze([]),
				flag: Object.freeze({ default: false }),
				settingsSchema: Object.freeze([
					Object.freeze({
						kind: 'secret',
						key: 'signingSecret',
						envVar: 'PLUGIN_SLACK_SIGNING_SECRET',
						label: 'Slack signing secret',
						required: true,
					}),
					Object.freeze({
						kind: 'string',
						key: 'channel',
						label: 'Channel',
						required: true,
						default: '#alerts',
					}),
				]),
			}),
		}),
	]),
}));

import PluginSettingsPage from '../[id].vue';

const overview = ref<unknown>(undefined);
const setPluginSettings = vi.fn();
const resetPluginSettings = vi.fn();
const showToast = vi.fn();
let operationCall = 0;

beforeAll(() => {
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useRoute', () => ({ params: { id: 'slack-approvals' } }));
	vi.stubGlobal('usePermissions', () => ({ isAdmin: ref(true), showAdminGate: ref(false) }));
	vi.stubGlobal('useConvexQuery', () => ({
		data: overview,
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
	vi.stubGlobal('useBackendOperation', () => {
		const run = operationCall++ % 2 === 0 ? setPluginSettings : resetPluginSettings;
		return { run, isLoading: ref(false) };
	});
});

beforeEach(() => {
	operationCall = 0;
	// The required secret's environment variable is ABSENT.
	overview.value = {
		plugins: [
			{
				pluginId: 'slack-approvals',
				packageName: '@example/slack-approvals',
				version: '1.0.0',
				enabled: true,
				capabilities: [],
				values: { channel: '#alerts' },
				secretsSet: { signingSecret: false },
			},
		],
		orphaned: [],
	};
	setPluginSettings.mockReset().mockResolvedValue({
		values: { channel: '#ops' },
		secretsSet: { signingSecret: false },
	});
	resetPluginSettings.mockReset();
	showToast.mockReset();
});

const passthroughStub = { template: '<section><slot name="header"/><slot/></section>' };
const buttonStub = { template: '<button v-bind="$attrs"><slot/></button>' };

function mountPage() {
	return mount(PluginSettingsPage, {
		global: {
			stubs: {
				UiQueryBoundary: passthroughStub,
				UiCard: passthroughStub,
				UiEmptyState: passthroughStub,
				UiConfirmationDialog: true,
				UiButton: buttonStub,
				UiBadge: passthroughStub,
				UiIconBox: true,
				Icon: true,
				NuxtLink: true,
			},
		},
	});
}

describe('plugin settings page — absent required secret', () => {
	it('still saves an edited setting when a required secret variable is unset', async () => {
		const wrapper = mountPage();
		const input = wrapper.get('input[type="text"]');
		await input.setValue('#ops');
		await wrapper.get('form').trigger('submit');
		await flushPromises();

		expect(setPluginSettings).toHaveBeenCalledWith({
			pluginId: 'slack-approvals',
			values: { channel: '#ops' },
		});
		expect(showToast).not.toHaveBeenCalledWith(
			expect.stringContaining('Fill in the required fields')
		);
	});

	it('warns which environment variable the deployment still needs', () => {
		const wrapper = mountPage();
		expect(wrapper.text()).toContain('PLUGIN_SLACK_SIGNING_SECRET');
	});

	it('still blocks the save on a required field the operator CAN fill', async () => {
		const wrapper = mountPage();
		await wrapper.get('input[type="text"]').setValue('   ');
		await wrapper.get('form').trigger('submit');
		await flushPromises();

		expect(setPluginSettings).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Fill in the required fields'));
	});
});
