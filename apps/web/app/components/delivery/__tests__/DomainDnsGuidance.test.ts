// @vitest-environment happy-dom
/**
 * Per-transport DNS guidance. The Mandrill entry is the one with a third step
 * beyond SPF and DKIM — ownership — and getting that wrong leaves an operator
 * with perfect DNS and mail Mandrill still bounces.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { DELIVERY_PROVIDER_KINDS } from '@owlat/shared/featureFlags';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const stubs = {
	Icon: { template: '<i />' },
	UiCard: { template: '<div><slot /></div>' },
};

async function mountGuidance(provider: string | null) {
	vi.stubGlobal('computed', computed);
	vi.stubGlobal('ref', ref);
	vi.stubGlobal('useOrganizationQuery', () => ({ data: { value: { provider } } }));
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	const component = (await import('../DomainDnsGuidance.vue')).default;
	const wrapper = mount(component, { global: { plugins: [createTestI18n()], stubs } });
	// The body is behind a disclosure; open it so the points are asserted.
	const toggle = wrapper.find('button');
	if (toggle.exists()) await toggle.trigger('click');
	return wrapper;
}

// NOT `unstubAllGlobals`: the shared setup file installs Vue's reactivity
// primitives as globals, and clearing every stub would take those with it.
afterEach(() => {
	vi.resetModules();
});

describe('DomainDnsGuidance', () => {
	it('has guidance for every shipped transport kind', async () => {
		for (const kind of DELIVERY_PROVIDER_KINDS) {
			const wrapper = await mountGuidance(kind);
			expect(wrapper.text().length).toBeGreaterThan(0);
			expect(wrapper.text()).not.toContain('undefined');
		}
	});

	it('renders nothing for an unrecognized transport', async () => {
		expect((await mountGuidance('not-a-transport')).text()).toBe('');
		expect((await mountGuidance(null)).text()).toBe('');
	});

	it('names all three Mandrill steps, ownership included', async () => {
		const text = (await mountGuidance('mandrill')).text();
		expect(text).toContain('Mailchimp Transactional');
		expect(text).toContain('SPF include');
		expect(text).toContain('mandrill._domainkey');
		expect(text).toContain('domain verification');
		// The consequence of skipping ownership, stated rather than implied.
		expect(text).toContain('Mandrill rejects mail from this domain');
	});

	it('points at the derived records instead of restating a DKIM key', async () => {
		// Restating the shared public key here would be a second copy of a value
		// only the backend registers — and the first one to go stale.
		const text = (await mountGuidance('mandrill')).text();
		expect(text).toContain('Mailchimp Transactional sending domains');
		expect(text).not.toContain('v=DKIM1');
	});
});
