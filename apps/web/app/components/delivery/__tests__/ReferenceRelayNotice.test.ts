// @vitest-environment happy-dom
/**
 * Plan D8's single-reference-relay warning, on the screen. The properties that
 * matter are what it does NOT render: nothing on a standalone deployment, and
 * nothing when the relay is describable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed } from 'vue';
import { MULTI_RELAY_DETAIL_PREFIX } from '@owlat/shared/deliverabilityAlignment';

const stubs = { Icon: { template: '<i />' } };

async function mountNotice(arms: unknown) {
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('useOrganizationQuery', () => ({ data: { value: arms } }));
	const component = (await import('../ReferenceRelayNotice.vue')).default;
	return mount(component, { global: { stubs } });
}

// NOT `unstubAllGlobals`: the shared setup file installs Vue's reactivity
// primitives as globals, and clearing every stub would take those with it.
afterEach(() => {
	vi.resetModules();
});

describe('ReferenceRelayNotice', () => {
	it('renders nothing on a standalone deployment', async () => {
		const wrapper = await mountNotice({ reference: { kind: 'none' } });
		expect(wrapper.find('[data-testid="reference-relay-notice"]').exists()).toBe(false);
	});

	it('renders nothing while the read is in flight', async () => {
		const wrapper = await mountNotice(undefined);
		expect(wrapper.find('[data-testid="reference-relay-notice"]').exists()).toBe(false);
	});

	it('names the enabled relays by rendering the backend’s sentence verbatim', async () => {
		const detail = `${MULTI_RELAY_DETAIL_PREFIX} (mandrill, ses), so there is no single second arm for example.com to be compared against.`;
		const wrapper = await mountNotice({ reference: { kind: 'unknown', detail } });
		expect(wrapper.find('[data-testid="reference-relay-detail"]').text()).toBe(detail);
		expect(wrapper.text()).toContain('More than one relay is configured');
		expect(wrapper.text()).toContain('Keep exactly one relay enabled');
	});

	it('asks for verification, not for fewer relays, on the single-relay branch', async () => {
		const wrapper = await mountNotice({
			reference: {
				kind: 'unknown',
				detail:
					'A relay is configured (mandrill) but example.com has no verified signing identity for it, so the two arms cannot be compared.',
			},
		});
		expect(wrapper.text()).toContain('Verify this sending domain');
		expect(wrapper.text()).not.toContain('Keep exactly one relay enabled');
	});
});
