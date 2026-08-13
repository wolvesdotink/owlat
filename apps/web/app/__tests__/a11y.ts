/**
 * SHARED AXE-CORE HARNESS FOR THE ACCESSIBILITY SUITES.
 *
 * MOUNTED, NOT LINTED. Every property axe checks — an accessible name on a
 * control, a label bound to a field that exists, a heading level that does not
 * skip, an aria-* attribute whose target is in the tree — is a property of the
 * RENDERED page. Source greps pass on a heading inside a comment and on an
 * `aria-labelledby` pointing at an id that no branch ever emits, which is
 * exactly the class of bug these suites exist to catch.
 *
 * THE REAL UI LAYER IS REGISTERED, NOT STUBBED. `UiInput`/`UiSelect` own the
 * label-to-control association and `UiModal` owns the dialog roles; stubbing
 * them would audit the stubs. They come from `packages/ui/components/ui`
 * (the Nuxt layer this app extends) under the `Ui` prefix Nuxt gives them.
 * Feature components that a page pulls in are left unresolved on purpose —
 * they render as inert unknown elements, so a page audit covers the page's own
 * chrome and the child components carry their own suites.
 *
 * THREE RULE FAMILIES ARE OFF, and only these:
 *   - `color-contrast` needs a layout/CSS engine happy-dom does not have (no
 *     stylesheet is loaded here at all, so every colour would resolve to the
 *     initial value and the result would be fiction);
 *   - `region` / `landmark-one-main` / `page-has-heading-one` describe a whole
 *     DOCUMENT, and these mounts are page bodies whose `<main>` and skip link
 *     come from the layout above them (the layout is audited separately);
 *   - `scrollable-region-focusable` needs real scroll metrics.
 * Everything else in wcag2a/2aa/21a/21aa plus axe's best-practice set runs.
 */
import axe, { type ElementContext, type Result, type RunOptions } from 'axe-core';
import { mount, type MountingOptions, type VueWrapper } from '@vue/test-utils';
import { vi } from 'vitest';
import {
	defineAsyncComponent,
	defineComponent,
	h,
	inject,
	markRaw,
	nextTick,
	onActivated,
	onBeforeMount,
	onDeactivated,
	onErrorCaptured,
	onUpdated,
	provide,
	resolveComponent,
	useAttrs,
	useSlots,
	useTemplateRef,
	type Component,
} from 'vue';
import { useAuthForm } from '~/composables/useAuthForm';

const DISABLED_RULES = [
	'color-contrast',
	'region',
	'landmark-one-main',
	'page-has-heading-one',
	'scrollable-region-focusable',
] as const;

const RUN_OPTIONS: RunOptions = {
	// Collecting passes and incomplete results is the expensive half of a run and
	// nothing here reads them; the suites stay in the tens of milliseconds.
	resultTypes: ['violations'],
	// axe reaches into same-origin frames by postMessage, which happy-dom's
	// `srcdoc` frames cannot answer — the archive/share previews would throw
	// "Respondable target must be a frame in the current window". The framed
	// document is recipient HTML the sender wrote, not app markup, so nothing
	// auditable is lost.
	iframes: false,
	runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
	rules: Object.fromEntries(DISABLED_RULES.map((rule) => [rule, { enabled: false }])),
};

/** The Nuxt UI layer, registered under the `Ui` prefix Nuxt's auto-import gives it. */
const uiComponents: Record<string, Component> = {};
for (const [path, module] of Object.entries({
	...import.meta.glob('../../../../packages/ui/components/ui/*.vue', { eager: true }),
	...import.meta.glob('../components/ui/*.vue', { eager: true }),
})) {
	const name = path.split('/').pop()?.replace('.vue', '');
	if (name) uiComponents[`Ui${name}`] = (module as { default: Component }).default;
}

const NuxtLinkStub = defineComponent({
	name: 'NuxtLink',
	inheritAttrs: false,
	props: { to: { type: [String, Object], default: undefined } },
	setup(props, { attrs, slots }) {
		const href =
			typeof props.to === 'string' ? props.to : ((props.to as { path?: string })?.path ?? '#');
		return () => h('a', { ...attrs, href }, slots.default?.());
	},
});

const IconStub = defineComponent({
	name: 'Icon',
	props: { name: { type: String, default: '' } },
	// Matches the real @nuxt/icon output: a decorative glyph with no accessible
	// name, so an icon-only control still fails `button-name` here.
	setup: () => () => h('span', { 'aria-hidden': 'true' }),
});

export const a11yGlobal = {
	components: { ...uiComponents, NuxtLink: NuxtLinkStub, Icon: IconStub },
	// Several components pick their root element with
	// `<component :is="cond ? 'div' : resolveComponent('NuxtLink')">` (the app
	// gets this identifier from Nuxt's auto-imports). Template expressions
	// compile to `_ctx.resolveComponent`, which only exists if it is on the
	// render context — without it the mount throws instead of auditing. Vue's
	// real implementation is used so the registered NuxtLink stub above is
	// found and the row is audited as the `<a href>` a user actually gets.
	mocks: { resolveComponent },
	config: {
		// A page under audit deliberately leaves its feature components
		// unresolved; the resulting warning storm would bury a real one.
		warnHandler: (message: string): void => {
			if (!message.includes('Failed to resolve component')) console.warn(message);
		},
	},
};

/** A ref-shaped query result: what every Convex-backed composable hands a template. */
export function queryResult<T>(data: T) {
	return {
		data: ref(data),
		isLoading: ref(false),
		isRefetching: ref(false),
		error: ref(null),
		refetch: vi.fn(),
	};
}

/** A `usePaginatedQuery` result with a single, already-exhausted page. */
export function paginatedResult<T>(results: T[]) {
	return {
		results: ref(results),
		status: ref('Exhausted'),
		isLoading: ref(false),
		error: ref(null),
		loadMore: vi.fn(),
		reset: vi.fn(),
	};
}

/**
 * The Nuxt/app auto-imports a mounted page reaches for. Absent a stub these are
 * plain ReferenceErrors at setup time, so the default set is deliberately broad
 * and every entry is overridable per suite.
 */
function defaultStubs(): Record<string, unknown> {
	const route = {
		path: '/',
		fullPath: '/',
		name: 'index',
		params: {},
		query: {},
		hash: '',
		meta: {},
	};
	return {
		// Vue auto-imports the shared setup file does not cover.
		useSlots,
		useAttrs,
		useTemplateRef,
		onErrorCaptured,
		onBeforeMount,
		onUpdated,
		onActivated,
		onDeactivated,
		provide,
		inject,
		markRaw,
		defineAsyncComponent,

		// Nuxt.
		definePageMeta: vi.fn(),
		defineOgImageComponent: vi.fn(),
		useHead: vi.fn(),
		useSeoMeta: vi.fn(),
		useServerSeoMeta: vi.fn(),
		navigateTo: vi.fn(),
		refreshNuxtData: vi.fn(),
		useRoute: () => route,
		useRouter: () => ({
			push: vi.fn(),
			replace: vi.fn(),
			back: vi.fn(),
			resolve: (to: string) => ({ href: to }),
			currentRoute: ref(route),
		}),
		// Mirrors nuxt.config's `runtimeConfig.public` defaults — including the
		// legal/company block, which is EMPTY on a stock self-host install. A
		// stub that filled it in would hide the markup that install renders.
		useRuntimeConfig: () => ({
			public: {
				convexUrl: 'https://example.convex.cloud',
				convexSiteUrl: 'https://example.convex.site',
				convexDashboardUrl: '',
				siteUrl: 'https://owlat.test',
				isDesktopBuild: false,
				deploymentMode: 'selfhost',
				setupMode: false,
				owlatVersion: 'dev',
				owlatGitSha: 'unknown',
				owlatBuildDate: 'unknown',
				posthogApiKey: '',
				posthogHost: '',
				companyName: '',
				companyRepresentative: '',
				companyStreet: '',
				companyPostalCode: '',
				companyCity: '',
				companyCountry: '',
				companyEmail: '',
				companyPhone: '',
			},
		}),
		useNuxtApp: () => ({ $convex: convexClientStub(), hooks: { hook: vi.fn() } }),
		useState: <T>(_key: string, init?: () => T) => ref(init?.()),
		useCookie: () => ref(null),
		useRequestURL: () => new URL('https://owlat.test/'),
		// happy-dom's document URL is http://localhost:3000, so an unstubbed
		// relative `fetch`/`$fetch` in a page's `onMounted` really tries to open a
		// socket to the dev server and logs ECONNREFUSED per audit.
		$fetch: vi.fn(async () => ({})),
		fetch: vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({}),
			text: async () => '',
		})),

		// App-wide composables. Pure ones (no backend, no browser API) are wired
		// to their REAL implementation so the audit sees the real markup path.
		useAuthForm,
		useAuth: () => ({
			user: ref({ id: 'user1', name: 'Ada Lovelace', email: 'ada@example.com' }),
			sessionData: ref(null),
			status: ref('authenticated'),
			isAuthenticated: ref(true),
			isPending: ref(false),
			error: ref(null),
			activeOrganizationId: ref('org1'),
			hasActiveOrganization: ref(true),
			signInWithEmail: vi.fn(),
			signUpWithEmail: vi.fn(),
			signOut: vi.fn(),
			forgotPassword: vi.fn(),
			resetPassword: vi.fn(),
			refetch: vi.fn(),
		}),
		useOrganizationContext: () => ({
			organization: ref({ id: 'org1', name: 'Owlat', slug: 'owlat' }),
			organizationId: ref('org1'),
			organizations: ref([]),
			settings: ref(null),
			role: ref('owner'),
			user: ref({ id: 'user1', name: 'Ada Lovelace', email: 'ada@example.com' }),
			isLoading: ref(false),
			isSettingsLoading: ref(false),
			error: ref(null),
			setActive: vi.fn(),
			hasActiveOrganization: ref(true),
		}),
		usePermissions: () => ({
			role: ref('owner'),
			isOwner: ref(true),
			isAdmin: ref(true),
			canSendTestEmails: ref(true),
			canSendCampaigns: ref(true),
			canManageOrganization: ref(true),
			canManageContacts: ref(true),
			canAnnotateContacts: ref(true),
			canManageSettings: ref(true),
			canDeleteOrganization: ref(true),
			showAdminGate: ref(false),
		}),
		useToast: () => ({
			toasts: ref([]),
			showToast: vi.fn(),
			removeToast: vi.fn(),
			clearToasts: vi.fn(),
		}),
		useBackendOperation: () => ({ run: vi.fn(), isLoading: ref(false), error: ref(null) }),
		useConvex: convexClientStub,
		useConvexQuery: () => queryResult(undefined),
		useOrganizationQuery: () => queryResult(undefined),
		usePaginatedQuery: () => paginatedResult([]),
		// Every flag on: the audit should see the fullest surface a page can
		// render, not the subset a stripped instance shows.
		useFeatureFlag: () => ({
			flags: ref({}),
			isEnabled: () => true,
			isLoading: ref(false),
			error: ref(null),
		}),
		useKeyboardShortcuts: () => ({
			isHelpModalOpen: ref(false),
			registerShortcut: vi.fn(),
			unregisterShortcut: vi.fn(),
			registerNavigationShortcuts: vi.fn(),
			registerNewShortcut: vi.fn(),
			registerSaveShortcut: vi.fn(),
			registerEscapeHandler: vi.fn(),
			openHelpModal: vi.fn(),
			closeHelpModal: vi.fn(),
			getRegisteredShortcuts: () => [],
		}),
		useClickOutside: vi.fn(),
		useColorMode: () => reactive({ preference: 'dark', value: 'dark' }),
		useAppTheme: () => ({ theme: ref('dark'), setTheme: vi.fn() }),
	};
}

function convexClientStub() {
	return {
		query: vi.fn(async () => undefined),
		mutation: vi.fn(async () => undefined),
		action: vi.fn(async () => undefined),
		onUpdate: vi.fn(() => () => {}),
		watchQuery: vi.fn(() => ({ localQueryResult: () => undefined, onUpdate: () => () => {} })),
	};
}

/**
 * Install the auto-import stubs for one test. Call from `beforeEach` — the
 * refs handed out are fresh each time, so a page that writes to one cannot
 * leak that state into the next audit.
 */
export function installNuxtStubs(overrides: Record<string, unknown> = {}): void {
	for (const [name, value] of Object.entries({ ...defaultStubs(), ...overrides })) {
		vi.stubGlobal(name, value);
	}
}

export interface AuditOptions extends MountingOptions<Record<string, unknown>> {
	/** Runs after mount and after pending microtasks, before the scan. */
	prepare?: (wrapper: VueWrapper) => void | Promise<void>;
	/** Extra axe rule toggles, merged over the defaults. */
	rules?: RunOptions['rules'];
}

/**
 * Mount a component into the live document, scan it, and return one readable
 * line per violating node. Returning strings (rather than asserting inside)
 * keeps the failure diff legible: vitest prints the rule, the offending markup
 * and the fix, instead of `expected [ Object ] to equal []`.
 */
export async function auditA11y(
	component: Component,
	options: AuditOptions = {}
): Promise<string[]> {
	const { prepare, rules, global: globalOptions, ...mountOptions } = options;

	// axe reads layout and visibility off the live document, so the tree has to
	// be attached rather than rendered into a detached fragment.
	const container = document.createElement('div');
	document.body.appendChild(container);
	const preexisting = new Set(document.body.children);

	const wrapper = mount(component, {
		...mountOptions,
		attachTo: container,
		global: {
			...globalOptions,
			components: { ...a11yGlobal.components, ...globalOptions?.components },
			mocks: { ...a11yGlobal.mocks, ...globalOptions?.mocks },
			stubs: { ...globalOptions?.stubs },
			config: { ...a11yGlobal.config, ...globalOptions?.config },
		},
	} as MountingOptions<Record<string, unknown>>);

	try {
		// `onMounted` hooks that await a stubbed fetch settle here, so the audit
		// sees the loaded page rather than every page's spinner. One `nextTick`
		// is not enough: each awaited hop in the hook costs a microtask turn
		// before the state it sets can be rendered.
		await flushAsync();
		await prepare?.(wrapper);
		await flushAsync();
		// Dialogs `<Teleport to="body">`, so their markup is a sibling of the
		// container rather than a descendant. Scanning the document instead would
		// drag in happy-dom's bare `<html>` (no lang, no title) and report the
		// harness's own shell as the app's defect, so the scan takes the container
		// plus exactly what this mount added to the body.
		const teleported = [...document.body.children].filter(
			(child) => child !== container && !preexisting.has(child)
		);
		const context = teleported.length > 0 ? { include: [container, ...teleported] } : container;
		return await describeViolations(context, rules);
	} finally {
		wrapper.unmount();
		container.remove();
	}
}

/** Drain the mount's pending microtask chain and let every resulting render land. */
export async function flushAsync(turns = 5): Promise<void> {
	for (let turn = 0; turn < turns; turn++) {
		await Promise.resolve();
		await nextTick();
	}
}

/** Scan an already-rendered element (for suites that own their own mount). */
export async function describeViolations(
	target: ElementContext,
	rules?: RunOptions['rules']
): Promise<string[]> {
	const results = await axe.run(target, {
		...RUN_OPTIONS,
		rules: { ...RUN_OPTIONS.rules, ...rules },
	});
	return results.violations.flatMap(describeViolation);
}

function describeViolation(violation: Result): string[] {
	return violation.nodes.map((node) => {
		const summary = node.failureSummary?.split('\n').slice(1).join('; ').trim() ?? violation.help;
		return `${violation.id} [${violation.impact ?? 'n/a'}] ${summary} — ${node.html.slice(0, 160)}`;
	});
}
