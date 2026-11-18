/**
 * The "Plugins" settings row must stay reachable when a removed plugin left
 * residual settings behind, even though this deployment now bundles zero
 * plugins. Otherwise the orphan-purge UX is undiscoverable exactly when it is
 * needed.
 *
 * The bundled composition is mocked empty so the row depends solely on the
 * orphaned-settings signal.
 *
 * The operating-mode card sits on the Features page and paints
 * `@owlat/shared`'s `OPERATING_MODES`, whose copy is `sharedPkg.operatingModes.*`
 * KEYS — a card that bound them straight would show an admin the key path where
 * the mode's name belongs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { getFunctionName } from 'convex/server';

vi.mock('~/plugins/plugin-composition.generated', () => ({
	bundledPluginComposition: Object.freeze([]),
}));

import OperatingModeCard from '~/components/settings/OperatingModeCard.vue';
import { useAdminEnvironment } from '~/composables/useAdminEnvironment';
import { reachableAdminEntries } from '~/lib/adminSettingsRegistry';
import { expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { mountDashboardPage } from '~/__tests__/a11y';

const OVERVIEW = 'plugins/settings:getPluginSettingsOverview';

const overview = ref<{ plugins: unknown[]; orphaned: unknown[] } | undefined>(undefined);
const queried: string[] = [];

beforeEach(() => {
	overview.value = { plugins: [], orphaned: [] };
	queried.length = 0;

	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('useFeatureFlag', () => ({ flags: ref({}), isEnabled: () => false }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useConvexQuery', (reference: unknown, args: unknown) => {
		const name = getFunctionName(reference as never);
		const resolved = typeof args === 'function' ? (args as () => unknown)() : args;
		if (resolved !== 'skip') queried.push(name);
		return {
			data: name === OVERVIEW && resolved !== 'skip' ? overview : ref(undefined),
			isLoading: ref(false),
			error: ref(null),
		};
	});
});

const passthroughStub = { template: '<div><slot name="loading"/><slot/></div>' };

describe('Operating mode card — copy', () => {
	it('renders each preset name and audience line as words', () => {
		const wrapper = mountDashboardPage(OperatingModeCard, {
			stubs: {
				UiCard: passthroughStub,
				UiDisclosure: passthroughStub,
				UiModal: passthroughStub,
				UiButton: true,
			},
		});
		const text = wrapper.text();

		expect(text).toContain('CRM only');
		expect(text).toContain('Hosted mail server (Postbox)');
		expect(text).toContain('Run Owlat as your mail server (Gmail-equivalent).');
		expectFullyLocalized(wrapper);
	});
});

describe('Workspace settings — Plugins row', () => {
	const pluginsReachable = () => {
		const { environment } = useAdminEnvironment(ref(true));
		return reachableAdminEntries(environment.value).some((entry) => entry.id === 'plugins');
	};

	it('hides the row when no plugins are bundled and nothing is orphaned', () => {
		expect(pluginsReachable()).toBe(false);
	});

	it('shows the row when a removed plugin left residual settings behind', () => {
		overview.value = {
			plugins: [],
			orphaned: [{ flagKey: 'plugin.removed-pack', pluginId: 'removed-pack' }],
		};
		expect(pluginsReachable()).toBe(true);
	});

	it("never asks for the plugin overview on a member's session", () => {
		useAdminEnvironment(ref(false));
		expect(queried).not.toContain(OVERVIEW);
	});
});
