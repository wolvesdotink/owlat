// @vitest-environment happy-dom
/**
 * The migration flow page: the runbook's order, and the gating that makes that
 * order mean something.
 *
 * The steps are read off the same queries the rest of Delivery reads, so what
 * this pins is that a deployment which has not connected the key, or whose
 * Mandrill domain has not verified, cannot reach the preset — and that when it
 * can, the flow says so rather than simply going quiet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { api } from '@owlat/api';

const WEEK = 7 * 24 * 60 * 60 * 1000;

const stubs = {
	Icon: { template: '<i />' },
	NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
	UiCard: { template: '<div><slot /></div>' },
	DeliveryMigrationImportStep: { template: '<div data-testid="import-step-stub" />' },
	DeliveryMigrationPresetStep: {
		props: ['catalog', 'routes', 'isApplied', 'isBlocked', 'blockedReason'],
		template: '<div data-testid="preset-step-stub" :data-blocked="String(isBlocked)" />',
	},
	DeliveryRelayDomainStatus: { template: '<div data-testid="domain-status-stub" />' },
};

interface Identity {
	domain: string;
	status: 'unverified' | 'pending_dns' | 'verified' | 'failed';
	spf: { isValid: boolean } | null;
	dkim: { isValid: boolean } | null;
	verifiedAt: number | null;
	lastError: string | null;
	lastCheckedAt: number;
	nextCheckDueAt: number | null;
	proofMaxAgeMs: number;
}

function identity(over: Partial<Identity> = {}): Identity {
	return {
		domain: 'example.com',
		status: 'verified',
		spf: { isValid: true },
		dkim: { isValid: true },
		verifiedAt: Date.now() - 1000,
		lastError: null,
		lastCheckedAt: Date.now() - 1000,
		nextCheckDueAt: Date.now() + 60_000,
		proofMaxAgeMs: WEEK,
		...over,
	};
}

interface PageState {
	catalog: { kind: string; label: string; isAvailable: boolean }[];
	routes: {
		messageType: string;
		strategy: string;
		providers: { providerType: string; isEnabled: boolean }[];
	}[];
	identities: Identity[];
	isAdmin: boolean;
}

function migrationRoutes(): PageState['routes'] {
	return ['transactional', 'campaign', 'automation'].map((messageType) => ({
		messageType,
		strategy: 'adaptive_mix',
		providers: [
			{ providerType: 'mta', isEnabled: true },
			{ providerType: 'mandrill', isEnabled: true },
		],
	}));
}

async function mountPage(over: Partial<PageState> = {}) {
	const state: PageState = {
		catalog: [
			{ kind: 'mta', label: 'Own MTA', isAvailable: true },
			{ kind: 'mandrill', label: 'Mailchimp Transactional', isAvailable: true },
		],
		routes: [],
		identities: [identity()],
		isAdmin: true,
		...over,
	};
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('usePermissions', () => ({
		canManageOrganization: ref(state.isAdmin),
		showAdminGate: ref(!state.isAdmin),
	}));
	const answers = new Map<string, unknown>([
		[getFunctionName(api.providerRoutes.listTransportCatalog), state.catalog],
		[getFunctionName(api.providerRoutes.listRoutes), state.routes],
		[getFunctionName(api.domains.mandrillRelayQueries.listIdentities), state.identities],
	]);
	vi.stubGlobal('useOrganizationQuery', (query: FunctionReference<'query'>) => ({
		data: ref(answers.get(getFunctionName(query))),
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
	const component = (await import('../migrate.vue')).default;
	return mount(component, { global: { stubs } });
}

function stepState(wrapper: Awaited<ReturnType<typeof mountPage>>, id: string): string | undefined {
	return wrapper.find(`[data-testid="migration-step-${id}"]`).attributes('data-state');
}

beforeEach(() => {
	vi.resetModules();
});

afterEach(() => {
	vi.resetModules();
});

describe('the flow renders the runbook in order', () => {
	it('shows all five steps', async () => {
		const wrapper = await mountPage();
		for (const id of ['connect', 'history', 'domain', 'preset', 'watch']) {
			expect(wrapper.find(`[data-testid="migration-step-${id}"]`).exists()).toBe(true);
		}
	});

	it('confirms the key by presence, never by value', async () => {
		const wrapper = await mountPage();
		expect(stepState(wrapper, 'connect')).toBe('complete');
		const text = wrapper.find('[data-testid="migration-key-present"]').text();
		expect(text).toContain('MANDRILL_API_KEY');
	});

	it('sends the operator to the environment when the key is missing', async () => {
		const wrapper = await mountPage({
			catalog: [
				{ kind: 'mta', label: 'Own MTA', isAvailable: true },
				{ kind: 'mandrill', label: 'Mailchimp Transactional', isAvailable: false },
			],
		});
		expect(stepState(wrapper, 'connect')).toBe('current');
		expect(wrapper.find('[data-testid="migration-key-missing"]').exists()).toBe(true);
		// Everything downstream of the key is locked, and says why.
		expect(stepState(wrapper, 'history')).toBe('blocked');
		expect(stepState(wrapper, 'preset')).toBe('blocked');
	});
});

describe('the domain prerequisite gates the preset', () => {
	it('blocks the preset while Mandrill has not verified the domain', async () => {
		const wrapper = await mountPage({
			identities: [identity({ status: 'pending_dns', dkim: { isValid: false }, verifiedAt: null })],
		});
		// Not `blocked` — nothing stops the operator publishing DNS now; it simply
		// is not the step the flow is pointing at while the carry-over is open.
		expect(stepState(wrapper, 'domain')).toBe('upcoming');
		expect(stepState(wrapper, 'preset')).toBe('blocked');
		expect(wrapper.find('[data-testid="preset-step-stub"]').attributes('data-blocked')).toBe(
			'true'
		);
	});

	it('lists the outstanding DNS and ownership items per domain', async () => {
		const wrapper = await mountPage({
			identities: [
				identity({ status: 'pending_dns', spf: { isValid: false }, dkim: null, verifiedAt: null }),
			],
		});
		const row = wrapper.find('[data-testid="migration-domain-example.com"]').text();
		expect(row).toContain('SPF');
		expect(row).toContain('DKIM');
		expect(row).toContain('domain ownership');
	});

	it('explains the empty case rather than showing an empty checklist', async () => {
		const wrapper = await mountPage({ identities: [] });
		expect(wrapper.find('[data-testid="migration-domain-none"]').exists()).toBe(true);
		expect(stepState(wrapper, 'preset')).toBe('blocked');
	});

	it('opens the preset once the domain is verified and fresh', async () => {
		const wrapper = await mountPage();
		expect(stepState(wrapper, 'domain')).toBe('complete');
		expect(wrapper.find('[data-testid="preset-step-stub"]').attributes('data-blocked')).toBe(
			'false'
		);
	});

	it('treats an aged-out proof as unverified, exactly as routing does', async () => {
		const wrapper = await mountPage({
			identities: [identity({ lastCheckedAt: Date.now() - WEEK - 1000 })],
		});
		expect(stepState(wrapper, 'domain')).not.toBe('complete');
		expect(stepState(wrapper, 'preset')).toBe('blocked');
	});
});

describe('the ramp pointer', () => {
	it('is locked until the preset is applied', async () => {
		const wrapper = await mountPage();
		expect(stepState(wrapper, 'watch')).toBe('blocked');
		expect(wrapper.find('[data-testid="migration-cells-link"]').exists()).toBe(false);
	});

	it('points at the cells screen once the routes carry the migration shape', async () => {
		const wrapper = await mountPage({ routes: migrationRoutes() });
		expect(stepState(wrapper, 'preset')).toBe('complete');
		expect(stepState(wrapper, 'watch')).toBe('complete');
		expect(wrapper.find('[data-testid="migration-cells-link"]').attributes('href')).toBe(
			'/dashboard/admin/delivery/advanced/cells'
		);
	});
});

describe('permissions', () => {
	it('shows a member the state without the controls', async () => {
		const wrapper = await mountPage({ isAdmin: false });
		expect(wrapper.find('[data-testid="migrate-admin-only"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="import-step-stub"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="preset-step-stub"]').exists()).toBe(false);
		// The read-only parts are still there.
		expect(wrapper.find('[data-testid="migration-domain-checklist"]').exists()).toBe(true);
	});
});
