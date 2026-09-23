// @vitest-environment happy-dom
/**
 * Each mail setting lives where an admin looks for it (#796):
 *   - the Sealed mail page is about sealing only (policy, recovery kits,
 *     re-sealing) and is called "Sealed mail" in its title;
 *   - "Search inside message bodies" is on General, in the `#mail-search`
 *     section the search page links to;
 *   - "Require TLS for incoming mail" is on Delivery provider → Incoming mail
 *     (covered by the transport page suite).
 */
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import SealedMailPage from '../sealed-mail.vue';
import GeneralPage from '../general.vue';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

let enabledFlags = new Set<string>();

beforeEach(() => {
	enabledFlags = new Set(['sealedMail', 'postbox']);
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('useOrganizationContext', () => ({
		hasActiveOrganization: ref(true),
		isLoading: ref(false),
	}));
	vi.stubGlobal('useOrganization', () => ({
		organization: ref({ name: 'Owlat' }),
		update: vi.fn(),
	}));
	vi.stubGlobal('useFeatureFlag', () => ({
		flags: ref({}),
		isEnabled: (flag: string) => enabledFlags.has(flag),
	}));
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: ref({ sealPolicy: 'auto' }),
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
	vi.stubGlobal('useUnsavedChanges', () => ({
		showDialog: ref(false),
		confirmDiscard: vi.fn(),
		confirmSave: vi.fn(),
		cancelNavigation: vi.fn(),
		setHasChanges: vi.fn(),
	}));
});

const globalOptions = {
	stubs: {
		Icon: true,
		UiButton: { template: '<button type="button"><slot /></button>' },
		UiCard: { template: '<div><slot /></div>' },
		UiInput: true,
		UiSelect: true,
		UiSwitch: true,
		UiToggle: true,
		UiSpinner: true,
		UiEmptyState: true,
		UnsavedChangesDialog: true,
		UiErrorAlert: true,
		NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
		SettingsInboundRetentionCard: true,
		SettingsBodySearchIndexCard: true,
		SettingsConnectedWorkspaces: true,
	},
	components: { UiQueryBoundary: QueryBoundary },
	plugins: [createTestI18n()],
};

describe('Sealed mail page', () => {
	it('is named "Sealed mail" and holds only sealing settings', () => {
		const wrapper = mount(SealedMailPage, { global: globalOptions });
		expect(wrapper.find('h1').text()).toBe('Sealed mail');
		expect(wrapper.find('[data-testid="seal-policy-auto"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Recovery kit');
		expect(wrapper.find('[data-testid="inbound-tls-required"]').exists()).toBe(false);
		expect(wrapper.find('settings-body-search-index-card-stub').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('Require TLS for incoming mail');
		wrapper.unmount();
	});
});

describe('General page mail search section', () => {
	it('holds body search under #mail-search where mail exists', () => {
		const wrapper = mount(GeneralPage, { global: globalOptions });
		const section = wrapper.find('#mail-search');
		expect(section.exists()).toBe(true);
		expect(section.find('h2').text()).toBe('Mail search');
		expect(section.find('settings-body-search-index-card-stub').exists()).toBe(true);
		wrapper.unmount();
	});

	it('leaves the section out where there is no mail to search', () => {
		enabledFlags = new Set();
		const wrapper = mount(GeneralPage, { global: globalOptions });
		expect(wrapper.find('#mail-search').exists()).toBe(false);
		wrapper.unmount();
	});
});
