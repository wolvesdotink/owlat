// @vitest-environment happy-dom
/**
 * THE UNSAVED-CHANGES GUARD ON THE LONG SETTINGS FORMS (UX plan item 16).
 *
 * Six surfaces already prompted before dropping an edit — the email editor, the
 * campaign builder, the automation builder, instance/general. The 400-line
 * admin forms did not: a sidebar click, a command-palette jump or a tab close
 * threw the work away without a word.
 *
 * There are two halves to check and they fail differently.
 *
 * WIRING (source): every guarded page has to reach for the SAME composable and
 * the SAME dialog, and has to push its dirty flag into the guard. A page that
 * renders the dialog but never calls `setHasChanges` is a dialog that can never
 * open, and no mount would notice because the markup is all there. The behaviour
 * of `useUnsavedChanges` itself is covered by
 * `composables/__tests__/useUnsavedChanges.test.ts`; what only a source read can
 * say is that seven pages agree on how to use it.
 *
 * DIRTINESS (mount): the guard is only as good as the predicate feeding it, and
 * the predicate is the part that regresses. Provider routing stands in for the
 * whole set because its draft is the hardest shape — it lives in a modal, so
 * "dirty" has to mean "the modal is open AND the draft has moved off its seed",
 * and a predicate that forgot the second half would prompt every operator who
 * opened a route just to read it.
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ref } from 'vue';
import ProviderRoutingPage from '../admin/delivery/provider-routing.vue';
// The route cards are a real child component, and the "Configure" control this
// suite clicks lives in them — stubbing it would leave nothing to click.
import DeliveryProviderRouteCard from '~/components/delivery/ProviderRouteCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, '..', rel), 'utf8');

/**
 * Every page that holds real form state behind a route. `instance/general.vue`
 * is on the list as the REFERENCE — it is the page the other six were wired to
 * match, so if it ever loses the pattern the list stops meaning anything.
 */
const guardedPages = {
	'admin/delivery/provider-routing.vue': read('admin/delivery/provider-routing.vue'),
	'admin/delivery/webhooks.vue': read('admin/delivery/webhooks.vue'),
	'admin/instance/agent.vue': read('admin/instance/agent.vue'),
	'admin/instance/ai-provider.vue': read('admin/instance/ai-provider.vue'),
	'admin/instance/email-theme.vue': read('admin/instance/email-theme.vue'),
	'admin/instance/forms.vue': read('admin/instance/forms.vue'),
	'admin/instance/general.vue': read('admin/instance/general.vue'),
	'preferences/account.vue': read('preferences/account.vue'),
};

describe.each(Object.entries(guardedPages))('%s guards its form', (_name, source) => {
	it('routes through the one shared composable and the one shared dialog', () => {
		expect(source).toContain('useUnsavedChanges({');
		expect(source).toContain("import { UnsavedChangesDialog } from '@owlat/email-builder'");
		expect(source).toContain('<UnsavedChangesDialog');
	});

	it('feeds its own dirty state into the guard', () => {
		// Without this the dialog is unreachable: the guard defaults to clean and
		// nothing ever tells it otherwise.
		expect(source).toMatch(/setHasChanges\((?:dirty|create \|\| edit|add \|\| edit)\)/);
	});

	it('keeps the user on the page when the save fails', () => {
		// `confirmSave` navigates as soon as `onSave` resolves, so a save that
		// failed has to throw — otherwise the guard clears the dirty flag and
		// leaves for the pending route with the edits still unwritten.
		expect(source).toContain("throw new Error('Save failed')");
	});

	it('wires all three dialog outcomes', () => {
		expect(source).toContain('@close="cancelNavigation"');
		expect(source).toContain('@discard="confirmDiscard"');
		expect(source).toMatch(/@save="(?:confirmSave|handleGuardSave)"/);
	});
});

// ── The predicate, on the hardest-shaped draft in the set ────────────────────

/** Captures what the page pushes into the guard across a mount. */
function guardSpy() {
	const setHasChanges = vi.fn();
	vi.stubGlobal('useUnsavedChanges', () => ({
		showDialog: ref(false),
		hasUnsavedChanges: ref(false),
		pendingRoute: ref(null),
		confirmDiscard: vi.fn(),
		confirmSave: vi.fn(),
		cancelNavigation: vi.fn(),
		setHasChanges,
	}));
	return setHasChanges;
}

const passthrough = { template: '<div><slot /></div>' };

const globalOptions = {
	stubs: {
		Icon: true,
		UiIconBox: true,
		UiEmptyState: true,
		UiConfirmationDialog: true,
		UnsavedChangesDialog: true,
		DashboardListSkeleton: true,
		DeliveryReferenceRelayNotice: true,
		DeliveryRelayDomainStatus: true,
		DeliveryProviderRouteSummary: true,
		DeliveryProviderRouteProviderList: true,
		DeliveryDeliverabilityFallbackEditor: true,
		// Rendered inline so the draft's controls are reachable without driving
		// the real modal's teleport.
		UiModal: passthrough,
		UiCard: passthrough,
		NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
	},
	components: { DeliveryProviderRouteCard },
	plugins: [createTestI18n()],
};

function stubPage(): void {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn(), isLoading: ref(false) }));
	vi.stubGlobal('useOrganizationContext', () => ({
		hasActiveOrganization: ref(true),
		isLoading: ref(false),
	}));
	vi.stubGlobal('useOrganizationQuery', () => ({
		data: ref(undefined),
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	}));
}

describe('provider routing only calls the draft dirty once it has moved', () => {
	beforeEach(() => {
		stubPage();
	});

	it('stays clean while no route editor is open', () => {
		const setHasChanges = guardSpy();
		mount(ProviderRoutingPage, { global: globalOptions });

		expect(setHasChanges).toHaveBeenCalledWith(false);
		expect(setHasChanges).not.toHaveBeenCalledWith(true);
	});

	it('stays clean when a route is opened and only read', async () => {
		const setHasChanges = guardSpy();
		const wrapper = mount(ProviderRoutingPage, { global: globalOptions });

		await openFirstRouteEditor(wrapper);

		expect(setHasChanges).not.toHaveBeenCalledWith(true);
	});

	it('reports dirty once the open draft diverges from its seed', async () => {
		const setHasChanges = guardSpy();
		const wrapper = mount(ProviderRoutingPage, { global: globalOptions });

		await openFirstRouteEditor(wrapper);
		await wrapper.find('#route-ip-pool').setValue('warm-pool-a');

		expect(setHasChanges).toHaveBeenLastCalledWith(true);
	});
});

/** Clicks the first message type's "Configure" control. */
async function openFirstRouteEditor(wrapper: ReturnType<typeof mount>): Promise<void> {
	const configure = wrapper.findAll('button');
	expect(configure.length).toBeGreaterThan(0);
	await configure[0]!.trigger('click');
}
