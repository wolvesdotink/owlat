// @vitest-environment happy-dom
/**
 * ACCESSIBILITY PASS ACROSS EVERY PREFERENCES SCREEN.
 *
 * Preferences is where this app's forms live — a dozen-and-a-half pages of
 * toggles, selects, dialogs and destructive confirmations, each maintained by
 * whoever shipped the feature behind it. That is exactly the shape of surface
 * where a label quietly stops matching its control, so the suite is written
 * over the WHOLE directory rather than a hand-picked few: adding a page without
 * adding it here fails `covers every page in the directory` below.
 *
 * The shell is audited first and separately (it owns the nav, the `<h1>` and
 * the back link every page inherits), then each page for its own chrome. See
 * `~/__tests__/a11y` for what the harness covers and what it deliberately does
 * not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, Suspense, type Component } from 'vue';
import {
	auditA11y,
	dashboardShellStubs,
	installNuxtStubs,
	paginatedResult,
	queryResult,
} from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useClickOutside } from '~/composables/useClickOutside';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { useFormModal } from '~/composables/useFormModal';
import { useFormValidation } from '~/composables/useFormValidation';
import { useLocalStorage } from '~/composables/useLocalStorage';
import PreferencesLayout from '~/layouts/preferences.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

// The account page imports this one explicitly rather than by auto-import, so a
// global stub cannot reach it — and the real module builds a BetterAuth client
// that opens a socket on import.
vi.mock('~/composables/useOrganization', () => ({
	useOrganization: () => ({
		organization: ref({ id: 'org1', name: 'Owlat' }),
		members: ref([]),
		fetchMembers: vi.fn(),
		isLoading: ref(false),
	}),
}));

// The security page imports this one explicitly, and the real module builds a
// BetterAuth client that opens a socket on import.
vi.mock('~/composables/useAccountSecurity', () => ({
	useAccountSessions: () => ({
		sessions: ref([]),
		otherSessionCount: ref(0),
		isLoading: ref(false),
		hasLoadError: ref(false),
		refresh: vi.fn(),
		revoke: vi.fn(),
		revokeOthers: vi.fn(),
	}),
	useTwoFactorEnrolment: () => ({
		begin: vi.fn(),
		confirm: vi.fn(),
		disable: vi.fn(),
		regenerateBackupCodes: vi.fn(),
	}),
}));

/**
 * Every page under `pages/dashboard/preferences/`, keyed by the route segment.
 * Globbed rather than listed so a new page joins the audit the moment it is
 * added — the one property a hand-written list cannot hold.
 */
const pageModules = import.meta.glob('../**/*.vue', { eager: true }) as Record<
	string,
	{ default: Component }
>;
const pages = Object.entries(pageModules)
	.map(([path, module]) => ({ name: path.replace('../', '').replace('.vue', ''), module }))
	.sort((a, b) => a.name.localeCompare(b.name));

beforeEach(() => {
	installNuxtStubs({
		...i18nStubs,
		...dashboardShellStubs(),
		// Pure composables run for real: the pages branch on them, and the
		// label-to-control bindings under audit are built out of their state.
		useClickOutside,
		useClickOutsideSelector: useClickOutside,
		useDebouncedSearch,
		useFormModal,
		useFormValidation,
		useLocalStorage,
		useRouteId: () => ref('mbx1'),

		// Backend-backed page composables, answered empty — the branch a fresh
		// account opens on, and the one with the most bespoke markup.
		useDesktopWorkspaces: () => ({
			workspaces: ref([]),
			activeId: ref(null),
			active: ref(null),
			addWorkspace: vi.fn(),
			completeConnection: vi.fn(),
			switchTo: vi.fn(),
			removeWorkspace: vi.fn(),
			setWorkspaceAccent: vi.fn(),
			signOutWorkspace: vi.fn(),
		}),
		useDesktopSettings: () => ({
			isDesktop: ref(false),
			autostartEnabled: ref(false),
			isReady: ref(true),
			setAutostart: vi.fn(),
		}),
		useDesktopAppSettings: () => ({
			global: ref({}),
			setGlobal: vi.fn(),
			workspaceLocal: ref({}),
			setWorkspaceLocal: vi.fn(),
			isLoading: ref(false),
		}),
		usePostboxAppPasswords: () => ({
			passwords: ref([]),
			isLoading: ref(false),
			generate: vi.fn(),
			revoke: vi.fn(),
		}),
		usePostboxFilters: () => ({
			filters: ref([]),
			isLoading: ref(false),
			create: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
			reorder: vi.fn(),
		}),
		usePostboxSignatures: () => ({
			signatures: ref([]),
			defaultSignature: ref(null),
			isLoading: ref(false),
			create: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
		}),
		usePostboxSnippets: () => ({
			snippets: ref([]),
			isLoading: ref(false),
			create: vi.fn(),
			update: vi.fn(),
			remove: vi.fn(),
		}),
		useOrganization: () => ({
			organization: ref({ id: 'org1', name: 'Owlat' }),
			members: ref([]),
			fetchMembers: vi.fn(),
			isLoadingMembers: ref(false),
			isLoading: ref(false),
		}),
		useRoute: () => ({
			path: '/dashboard/preferences',
			fullPath: '/dashboard/preferences',
			name: 'preferences',
			params: {},
			query: {},
			hash: '',
			meta: {},
		}),
		useConvexQuery: () => queryResult(undefined),
		useOrganizationQuery: () => queryResult(undefined),
		usePaginatedQuery: () => paginatedResult([]),
		useOperationErrorToast: () => ({ showOperationError: vi.fn() }),
		// The unsaved-changes guard registers `onBeforeRouteLeave`, which needs a
		// matched route record the harness does not mount. The pages only read the
		// dialog's `show` flag and its three handlers, so the audit gets those.
		useUnsavedChanges: () => ({
			showDialog: ref(false),
			hasUnsavedChanges: ref(false),
			pendingRoute: ref(null),
			confirmDiscard: vi.fn(),
			confirmSave: vi.fn(),
			cancelNavigation: vi.fn(),
			setHasChanges: vi.fn(),
		}),
		useNativeFilePicker: () => ({ isDesktop: ref(false), pickNativeFiles: vi.fn() }),
		usePostboxActiveMailbox: () => ({ mailboxId: ref(null), mailbox: ref(null) }),
		usePostboxMailbox: () => ({
			mailboxes: ref([]),
			sections: ref([]),
			currentMailbox: ref(null),
			setCurrentMailbox: vi.fn(),
			switchToMailbox: vi.fn(),
			isLoading: ref(false),
			error: ref(null),
		}),
		usePostboxSettings: () => ({ settings: ref(null), isLoading: ref(false) }),
	});
});

describe('preferences shell — accessibility', () => {
	it('has no axe violations, landmarks and skip link included', async () => {
		const violations = await auditA11y(PreferencesLayout, {
			slots: { default: '<p>Page under the preferences shell</p>' },
			global: { plugins: [createTestI18n()] },
			// Fragment scope, not page scope: this shell NESTS inside `dashboard`,
			// which is what owns `<main>`, the skip link and the document
			// landmarks. Those are covered by the dashboard layout's own audit;
			// what is this shell's own is its section nav and its `<h1>`.
			prepare: (wrapper) => {
				expect(wrapper.findAll('nav a').length).toBeGreaterThan(3);
			},
		});
		expect(violations).toEqual([]);
	});
});

/**
 * Two of these pages have an async `setup()` (they await a first read before
 * they render), and Vue refuses to mount one without a `<Suspense>` above it.
 * Every page is audited through the same boundary so the suite has one mount
 * path rather than a special case that quietly stops covering a page the day
 * its setup turns async.
 */
function suspended(page: Component): Component {
	return defineComponent({
		name: 'SuspenseHost',
		setup: () => () => h(Suspense, null, { default: () => h(page) }),
	});
}

/**
 * The two routes that legitimately paint (almost) nothing, and why:
 *  - `external-account` is a kept-alive bookmark target that redirects to the
 *    import wizard; its whole body is a spinner;
 *  - `members/[mailboxId]` is a heading over a roster, and the roster is empty
 *    until the mailbox read lands.
 * Everything else has copy before its data does, so a near-empty body means the
 * page threw at setup and the audit covered nothing.
 */
const INTENTIONALLY_THIN = new Set(['external-account', 'members/[mailboxId]']);

describe.each(pages)('preferences/$name — accessibility', ({ name, module }) => {
	it('has no axe violations on a fresh account', async () => {
		const violations = await auditA11y(suspended(module.default), {
			global: { plugins: [createTestI18n()] },
			prepare: (wrapper) => {
				if (INTENTIONALLY_THIN.has(name)) expect(wrapper.html()).not.toBe('<!---->');
				else expect(wrapper.text().trim().length).toBeGreaterThan(24);
			},
		});
		expect(violations).toEqual([]);
	});
});

describe('the audit', () => {
	it('covers every page in the directory', () => {
		// Cheap tripwire: the glob above is only as good as the directory, so a
		// page count that collapses (a bad glob, a moved directory) is caught
		// here rather than by a suite that quietly audits nothing.
		expect(pages.length).toBeGreaterThanOrEqual(15);
	});
});
