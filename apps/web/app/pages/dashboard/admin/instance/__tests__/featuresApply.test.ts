// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

// Core registry only — the apply banner is registry-generic, so plugin flags
// add nothing this file needs to prove.
vi.mock('~/plugins/plugin-composition.generated', () => ({
	bundledPluginComposition: Object.freeze([]),
}));

import FeaturesPage from '../features.vue';
import MigrationModeCard from '~/components/settings/MigrationModeCard.vue';
import { useProfileSync } from '~/composables/useProfileSync';
import { createTestI18n } from '~/__tests__/i18n';

/**
 * Plan D4 — apply is explicit, not automatic. Toggling a flag persists it in
 * Convex only; when the toggle changes the derived docker-profile set, the
 * "Services out of sync — Apply & restart" banner surfaces (on the features
 * page for flag + pack toggles, and on the migration-mode card), Apply proxies
 * the resolved snapshot to the updater and renders per-service results, and an
 * unreachable updater degrades to the CLI fallback instructions.
 */

// ONE catalog-backed instance for the whole file: it is installed into every
// mount AND answers the `useI18n` auto-import. `beforeEach` resets the
// module-scoped drift state by calling `useProfileSync()` outside any component
// setup, where vue-i18n's own setup-only `useI18n` would throw — so the global
// resolves straight to this instance's composer, with the real messages behind
// it rather than a `t: (key) => key` stub (see ~/__tests__/i18n).
const i18n = createTestI18n();
Object.assign(globalThis, { useI18n: () => i18n.global });

const liveFlags = ref<Record<string, boolean>>({});
const configStatus = ref<Record<string, string[]> | undefined>({});
const settings = ref<{ isMigrationMode: boolean } | undefined>({ isMigrationMode: false });
const setFeatureFlag = vi.fn();
const setFeaturePack = vi.fn();
const updateSettings = vi.fn();
const showToast = vi.fn();
const fetchMock = vi.fn();

// The banner talks to two routes: the one-shot drift probe on mount and the
// apply proxy on click. One `$fetch` stub serves both, dispatching on URL.
const PROBE_URL = '/api/system/profile-drift';
const APPLY_URL = '/api/system/apply-profiles';
const NO_DRIFT = {
	reachable: true,
	drifted: false,
	missingProfiles: [],
	staleProfiles: [],
	services: [],
};
let probeBehavior: () => Promise<unknown>;
let applyBehavior: () => Promise<unknown>;

function stubProbe(response: unknown) {
	probeBehavior = () => Promise.resolve(response);
}
function stubApply(response: unknown) {
	applyBehavior = () => Promise.resolve(response);
}
function stubApplyFailure(error: Error) {
	applyBehavior = () => Promise.reject(error);
}
function callsTo(url: string) {
	return fetchMock.mock.calls.filter((call) => call[0] === url);
}

let queryCall = 0;
let operationCall = 0;
// Which component the useConvexQuery/useBackendOperation stubs serve: the
// features page issues 3 queries + 2 operations, the card 2 queries + 2 ops.
let harness: 'features' | 'card' = 'features';

beforeAll(() => {
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('$fetch', fetchMock);
	vi.stubGlobal('useConvexQuery', () => {
		if (harness === 'card') {
			const call = queryCall++ % 2;
			if (call === 0) return { data: settings, isLoading: ref(false), error: ref(null) };
			return { data: liveFlags, isLoading: ref(false), error: ref(null) };
		}
		const call = queryCall++ % 3;
		if (call === 0) {
			return { data: liveFlags, isLoading: ref(false), error: ref(null), refetch: vi.fn() };
		}
		if (call === 1) {
			return { data: ref(true), isLoading: ref(false), error: ref(null), refetch: vi.fn() };
		}
		return { data: configStatus, isLoading: ref(false), error: ref(null), refetch: vi.fn() };
	});
	vi.stubGlobal('useBackendOperation', () => {
		const call = operationCall++ % 2;
		if (harness === 'card') {
			return { run: call === 0 ? updateSettings : setFeatureFlag, isLoading: ref(false) };
		}
		return { run: call === 0 ? setFeatureFlag : setFeaturePack, isLoading: ref(false) };
	});
});

beforeEach(() => {
	queryCall = 0;
	operationCall = 0;
	// The composable's state is module-scoped (shared across surfaces by
	// design), so reset it through the composable itself between tests.
	const sync = useProfileSync();
	sync.pendingServices.value = [];
	sync.isApplying.value = false;
	sync.serviceResults.value = null;
	sync.applyError.value = null;
	sync.driftProbed.value = false;
	liveFlags.value = {};
	configStatus.value = {};
	settings.value = { isMigrationMode: false };
	showToast.mockReset();
	stubProbe(NO_DRIFT);
	stubApply({ success: true, profiles: [], services: [] });
	fetchMock
		.mockReset()
		.mockImplementation((url: string) => (url === PROBE_URL ? probeBehavior() : applyBehavior()));
	updateSettings.mockReset().mockResolvedValue({});
	// Mirror the live Convex subscription: a committed toggle updates the
	// stored map AND the reactive resolved-flags query.
	setFeatureFlag.mockReset().mockImplementation(async (args: { flag: string; value: boolean }) => {
		liveFlags.value = { ...liveFlags.value, [args.flag]: args.value };
		return { flags: { ...liveFlags.value }, cascaded: [] };
	});
	setFeaturePack.mockReset();
});

const passthroughStub = { template: '<section><slot name="header"/><slot/></section>' };
const confirmationStub = {
	props: ['open', 'title', 'confirmText'],
	emits: ['confirm', 'update:open'],
	template:
		'<div v-if="open" data-testid="confirmation"><h2>{{ title }}</h2><slot/><button data-testid="confirm" @click="$emit(\'confirm\')">{{ confirmText }}</button></div>',
};
const modalStub = {
	props: ['open', 'title'],
	emits: ['update:open'],
	template:
		'<div v-if="open" data-testid="modal"><h2>{{ title }}</h2><slot/><slot name="footer"/></div>',
};
const toggleStub = {
	props: ['modelValue', 'disabled', 'label'],
	emits: ['update:modelValue'],
	template:
		'<button data-testid="migration-toggle" :disabled="disabled" @click="$emit(\'update:modelValue\', !modelValue)">{{ label }}</button>',
};

const stubs = {
	UiQueryBoundary: passthroughStub,
	UiCard: passthroughStub,
	UiConfirmationDialog: confirmationStub,
	UiModal: modalStub,
	UiToggle: toggleStub,
	UiSpinner: true,
	UiIconBox: true,
	Icon: true,
	NuxtLink: true,
};

function mountFeatures() {
	harness = 'features';
	return mount(FeaturesPage, { global: { plugins: [i18n], stubs } });
}

function mountCard() {
	harness = 'card';
	return mount(MigrationModeCard, {
		props: { canManage: true },
		global: { plugins: [i18n], stubs },
	});
}

const banner = '[data-testid="profile-sync-banner"]';
const services = '[data-testid="profile-sync-services"]';
const applyButton = '[data-testid="profile-sync-apply"]';
const results = '[data-testid="profile-sync-results"]';
const fallback = '[data-testid="profile-sync-fallback"]';

describe('Features page — profile diff detection per flag', () => {
	it('surfaces the out-of-sync banner when a toggle changes the profile set', async () => {
		const wrapper = mountFeatures();
		expect(wrapper.find(banner).exists()).toBe(false);

		await wrapper.find('[data-testid="feature-switch-mail.external"]').trigger('click');
		await flushPromises();

		expect(setFeatureFlag).toHaveBeenCalledWith({ flag: 'mail.external', value: true });
		const bannerEl = wrapper.find(banner);
		expect(bannerEl.exists()).toBe(true);
		expect(bannerEl.text()).toContain('Services out of sync');
		expect(wrapper.find(services).text()).toBe('external-mail');
	});

	it('stays quiet for a toggle with no docker profile', async () => {
		const wrapper = mountFeatures();
		await wrapper.find('[data-testid="feature-switch-chat"]').trigger('click');
		await flushPromises();

		expect(setFeatureFlag).toHaveBeenCalledWith({ flag: 'chat', value: true });
		expect(wrapper.find(banner).exists()).toBe(false);
	});

	it('accumulates services across several toggles until applied', async () => {
		const wrapper = mountFeatures();
		await wrapper.find('[data-testid="feature-switch-mail.external"]').trigger('click');
		await flushPromises();
		await wrapper.find('[data-testid="feature-switch-postbox"]').trigger('click');
		await flushPromises();

		expect(wrapper.find(services).text()).toBe('external-mail, mta, personal-mail');
	});

	it('detects the diff for pack toggles too', async () => {
		setFeaturePack.mockImplementation(async () => {
			liveFlags.value = { ...liveFlags.value, inbox: true, chat: true, postbox: true };
			return { flags: { ...liveFlags.value }, cascaded: [] };
		});
		const wrapper = mountFeatures();
		await wrapper.find('button[aria-label="Toggle Email Client"]').trigger('click');
		await flushPromises();

		expect(setFeaturePack).toHaveBeenCalledWith({ pack: 'emailClient', value: true });
		expect(wrapper.find(services).text()).toBe('mta, personal-mail');
	});
});

describe('Features page — banner apply and resolve', () => {
	it('applies the resolved snapshot and renders per-service results', async () => {
		stubApply({
			success: true,
			profiles: ['external-mail'],
			services: [{ service: 'mail-sync', state: 'running', health: 'healthy' }],
		});
		const wrapper = mountFeatures();
		await wrapper.find('[data-testid="feature-switch-mail.external"]').trigger('click');
		await flushPromises();

		await wrapper.find(applyButton).trigger('click');
		await flushPromises();

		const applyCalls = callsTo(APPLY_URL);
		expect(applyCalls).toHaveLength(1);
		const [, opts] = applyCalls[0] as [
			string,
			{ method: string; body: { flags: Record<string, boolean> } },
		];
		expect(opts.method).toBe('POST');
		expect(opts.body.flags['mail.external']).toBe(true);

		// Banner resolves into the per-service result list.
		expect(wrapper.find(banner).exists()).toBe(false);
		const resultsEl = wrapper.find(results);
		expect(resultsEl.exists()).toBe(true);
		expect(wrapper.find('[data-testid="profile-sync-service-mail-sync"]').text()).toContain(
			'healthy'
		);

		await wrapper.find('[data-testid="profile-sync-dismiss"]').trigger('click');
		expect(wrapper.find(results).exists()).toBe(false);
	});

	it('keeps the banner with CLI fallback copy when the updater is unreachable', async () => {
		stubApplyFailure(new Error('updater sidecar unreachable'));
		const wrapper = mountFeatures();
		await wrapper.find('[data-testid="feature-switch-mail.external"]').trigger('click');
		await flushPromises();

		await wrapper.find(applyButton).trigger('click');
		await flushPromises();

		expect(wrapper.find(banner).exists()).toBe(true);
		const fallbackEl = wrapper.find(fallback);
		expect(fallbackEl.exists()).toBe(true);
		expect(fallbackEl.text()).toContain('updater sidecar unreachable');
		expect(fallbackEl.text()).toContain('owlat feature');
		expect(fallbackEl.text()).toContain('owlat restart');
	});

	it('a fresh profile-changing toggle invalidates stale apply results', async () => {
		const wrapper = mountFeatures();
		await wrapper.find('[data-testid="feature-switch-mail.external"]').trigger('click');
		await flushPromises();
		await wrapper.find(applyButton).trigger('click');
		await flushPromises();
		expect(wrapper.find(results).exists()).toBe(true);

		await wrapper.find('[data-testid="feature-switch-postbox"]').trigger('click');
		await flushPromises();
		expect(wrapper.find(results).exists()).toBe(false);
		expect(wrapper.find(services).text()).toBe('mta, personal-mail');
	});
});

describe('MigrationModeCard — same banner logic', () => {
	it('shows the out-of-sync banner after confirm-enabling mail.external', async () => {
		const wrapper = mountCard();
		expect(wrapper.find(banner).exists()).toBe(false);

		await wrapper.find('[data-testid="migration-toggle"]').trigger('click');
		expect(wrapper.find('[data-testid="confirmation"]').exists()).toBe(true);
		await wrapper.find('[data-testid="confirm"]').trigger('click');
		await flushPromises();

		expect(setFeatureFlag).toHaveBeenCalledWith({ flag: 'mail.external', value: true });
		expect(updateSettings).toHaveBeenCalledWith({ isMigrationMode: true });
		const bannerEl = wrapper.find(banner);
		expect(bannerEl.exists()).toBe(true);
		expect(wrapper.find(services).text()).toBe('external-mail');
	});

	it('shares pending drift with the features page through app-wide state', async () => {
		const card = mountCard();
		await card.find('[data-testid="migration-toggle"]').trigger('click');
		await card.find('[data-testid="confirm"]').trigger('click');
		await flushPromises();

		queryCall = 0;
		operationCall = 0;
		const page = mountFeatures();
		expect(page.find(banner).exists()).toBe(true);
		expect(page.find(services).text()).toBe('external-mail');
	});
});

/**
 * FU4 — the banner used to live only in this tab's memory, so a reload dropped
 * it while the services were still drifted. On mount the surfaces now ask the
 * server-side probe what the host actually has applied.
 */
describe('Durable drift — server-side probe on mount', () => {
	it('rehydrates the banner after a reload with no in-session drift', async () => {
		stubProbe({
			reachable: true,
			drifted: true,
			missingProfiles: ['personal-mail'],
			staleProfiles: ['external-mail'],
			services: [],
		});

		const wrapper = mountFeatures();
		await flushPromises();

		expect(callsTo(PROBE_URL)).toHaveLength(1);
		expect(wrapper.find(banner).exists()).toBe(true);
		expect(wrapper.find(services).text()).toBe('external-mail, personal-mail');
	});

	it('stays quiet when the host is already converged', async () => {
		const wrapper = mountFeatures();
		await flushPromises();

		expect(callsTo(PROBE_URL)).toHaveLength(1);
		expect(wrapper.find(banner).exists()).toBe(false);
	});

	it('probes once per page load across both admin surfaces', async () => {
		mountFeatures();
		await flushPromises();
		queryCall = 0;
		operationCall = 0;
		mountCard();
		await flushPromises();

		expect(callsTo(PROBE_URL)).toHaveLength(1);
	});

	it('unions probe drift with drift toggled in this session', async () => {
		stubProbe({
			reachable: true,
			drifted: true,
			missingProfiles: ['external-mail'],
			staleProfiles: [],
			services: [],
		});

		const wrapper = mountFeatures();
		await flushPromises();
		await wrapper.find('[data-testid="feature-switch-postbox"]').trigger('click');
		await flushPromises();

		expect(wrapper.find(services).text()).toBe('external-mail, mta, personal-mail');
	});

	it('applies the probe-hydrated drift and clears the banner', async () => {
		stubProbe({
			reachable: true,
			drifted: true,
			missingProfiles: ['personal-mail'],
			staleProfiles: [],
			services: [],
		});
		stubApply({
			success: true,
			profiles: ['personal-mail'],
			services: [{ service: 'imap', state: 'running', health: 'healthy' }],
		});

		const wrapper = mountFeatures();
		await flushPromises();
		await wrapper.find(applyButton).trigger('click');
		await flushPromises();

		expect(callsTo(APPLY_URL)).toHaveLength(1);
		expect(wrapper.find(banner).exists()).toBe(false);
		expect(wrapper.find(results).exists()).toBe(true);
	});

	it('arms the CLI fallback when the probe reports the updater unreachable', async () => {
		stubProbe({
			reachable: false,
			drifted: false,
			missingProfiles: [],
			staleProfiles: [],
			services: [],
			error: 'Updater profile-state returned 502',
		});

		const wrapper = mountFeatures();
		await flushPromises();
		// Nothing to show until drift is known — then the fallback copy is
		// already in place, without a doomed Apply round trip first.
		expect(wrapper.find(banner).exists()).toBe(false);

		await wrapper.find('[data-testid="feature-switch-mail.external"]').trigger('click');
		await flushPromises();

		const fallbackEl = wrapper.find(fallback);
		expect(fallbackEl.exists()).toBe(true);
		expect(fallbackEl.text()).toContain('Updater profile-state returned 502');
		expect(fallbackEl.text()).toContain('owlat restart');
	});

	it('degrades to the CLI fallback when the probe request itself fails', async () => {
		probeBehavior = () => Promise.reject(new Error('Platform admin access required'));

		const wrapper = mountFeatures();
		await flushPromises();
		await wrapper.find('[data-testid="feature-switch-mail.external"]').trigger('click');
		await flushPromises();

		expect(wrapper.find(fallback).text()).toContain('Platform admin access required');
	});
});
