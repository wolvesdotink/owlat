// @vitest-environment happy-dom
/**
 * A transport that is registered but not connected offers its setup where the
 * operator is choosing it: the `.env` lines and `owlat` commands for what it
 * needs, a poll while waiting, and "Connected" — plus a usable checkbox — once
 * the server reports it ready.
 */
import { describe, expect, it } from 'vitest';
import { config, mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import ProviderRouteProviderList from '../ProviderRouteProviderList.vue';
import EnvSetupSteps from '../EnvSetupSteps.vue';

Object.assign(globalThis, {
	useI18n: i18nStubs.useI18n,
	useCopyToClipboard: () => ({ copy: () => undefined, isCopied: () => false }),
});
config.global.plugins = [...(config.global.plugins ?? []), createTestI18n()];

const stubs = {
	Icon: { template: '<i />' },
	UiButton: {
		emits: ['click'],
		template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
	},
};

const REQUIRED: Record<string, readonly string[]> = {
	mta: ['MTA_API_URL', 'MTA_API_KEY'],
	ses: ['AWS_SES_REGION', 'AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY'],
};

function mountList(available: Set<string>) {
	return mount(ProviderRouteProviderList, {
		props: {
			modelValue: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: false },
				{ providerType: 'retired', isEnabled: false },
			],
			strategy: 'priority_failover',
			providerLabel: (kind: string) => kind,
			providerAvailable: (kind: string) => available.has(kind),
			setupVariables: (kind: string) => REQUIRED[kind] ?? [],
		},
		global: { stubs, components: { DeliveryEnvSetupSteps: EnvSetupSteps } },
	});
}

describe('ProviderRouteProviderList setup', () => {
	it('offers setup only for a registered transport that is not connected', () => {
		const wrapper = mountList(new Set(['mta']));
		expect(wrapper.find('[data-testid="route-provider-setup-ses"]').exists()).toBe(true);
		// Connected: nothing to set up. Retired: no setup exists to offer.
		expect(wrapper.find('[data-testid="route-provider-setup-mta"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="route-provider-setup-retired"]').exists()).toBe(false);
	});

	it('shows the exact lines for that transport when opened', async () => {
		const wrapper = mountList(new Set(['mta']));
		await wrapper.find('[data-testid="route-provider-setup-ses"]').trigger('click');
		expect(wrapper.find('[data-testid="env-setup-env"]').text()).toBe(
			'AWS_SES_REGION=\nAWS_SES_ACCESS_KEY_ID=\nAWS_SES_SECRET_ACCESS_KEY='
		);
	});

	it('passes the poll up so the page can re-read the catalog', async () => {
		const wrapper = mountList(new Set(['mta']));
		await wrapper.find('[data-testid="route-provider-setup-ses"]').trigger('click');
		await wrapper.find('[data-testid="env-setup-check-now"]').trigger('click');
		expect(wrapper.emitted('refresh')).toHaveLength(1);
	});

	it('flips to "Connected" and enables the transport once the server sees it', async () => {
		const available = new Set(['mta']);
		const wrapper = mountList(available);
		await wrapper.find('[data-testid="route-provider-setup-ses"]').trigger('click');
		const sesCheckbox = () => wrapper.findAll('input[type="checkbox"]')[1];
		expect(sesCheckbox()?.attributes('disabled')).toBeDefined();
		available.add('ses');
		await wrapper.setProps({ providerAvailable: (kind: string) => available.has(kind) });
		expect(wrapper.find('[data-testid="env-setup-connected"]').text()).toBe('Connected');
		expect(sesCheckbox()?.attributes('disabled')).toBeUndefined();
	});
});
