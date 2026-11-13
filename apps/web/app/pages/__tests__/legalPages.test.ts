/**
 * The Terms and Imprint pages render the operator's runtime config, which is
 * empty on a fresh self-hosted install. They must say so instead of rendering
 * headings over blank space, and the Terms page must not present the vendor's
 * contract (its company name, its billing clauses) as a self-host operator's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import ImprintPage from '../imprint.vue';
import TermsPage from '../terms.vue';

const emptyCompany = {
	companyName: '',
	companyRepresentative: '',
	companyStreet: '',
	companyPostalCode: '',
	companyCity: '',
	companyCountry: '',
	companyEmail: '',
	companyPhone: '',
};

function stubs(publicConfig: Record<string, unknown>) {
	installNuxtStubs({
		...i18nStubs,
		useRuntimeConfig: () => ({
			public: { deploymentMode: 'selfhost', ...emptyCompany, ...publicConfig },
		}),
		useAuth: () => ({ isAuthenticated: ref(false) }),
	});
}

function mountPage(component: object) {
	return mount(component, { global: { plugins: [createTestI18n()] } });
}

beforeEach(() => {
	vi.unstubAllGlobals();
});

describe('terms page', () => {
	it('says a self-hosted operator has not published terms instead of showing the vendor contract', () => {
		stubs({ companyName: 'Northwind Studio', companyEmail: 'legal@northwind.example' });
		const wrapper = mountPage(TermsPage);

		expect(wrapper.find('[data-testid="terms-unpublished"]').exists()).toBe(true);
		expect(wrapper.text()).not.toContain('Wolves');
		expect(wrapper.text()).not.toContain('Billing');
		expect(wrapper.find('a[href="mailto:legal@northwind.example"]').exists()).toBe(true);
	});

	it('shows the terms on the hosted deployment, with no stray commas for an unset address', () => {
		stubs({ deploymentMode: 'hosted', companyName: 'Owlat Hosting' });
		const wrapper = mountPage(TermsPage);

		expect(wrapper.find('[data-testid="terms-unpublished"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('Billing');
		expect(wrapper.text()).not.toMatch(/,\s*,/);
	});
});

describe('imprint page', () => {
	it('says no imprint is published when the operator configured no company', () => {
		stubs({});
		const wrapper = mountPage(ImprintPage);

		expect(wrapper.find('[data-testid="imprint-unpublished"]').exists()).toBe(true);
		expect(wrapper.text()).not.toContain('Represented by');
	});

	it('leaves out rows whose value is unset', () => {
		stubs({ companyName: 'Northwind Studio', companyCity: 'Hamburg' });
		const wrapper = mountPage(ImprintPage);

		expect(wrapper.text()).toContain('Northwind Studio');
		expect(wrapper.text()).toContain('Hamburg');
		expect(wrapper.text()).not.toContain('Phone:');
		expect(wrapper.text()).not.toContain('Represented by');
	});
});
