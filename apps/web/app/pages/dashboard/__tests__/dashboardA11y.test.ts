// @vitest-environment happy-dom
/**
 * ACCESSIBILITY PASS ACROSS THE DASHBOARD SURFACES A MEMBER LIVES IN.
 *
 * The shell layout is audited first and separately: it owns the landmarks, the
 * skip link and the navigation rail that every other page inherits, so a defect
 * there is a defect on every screen. The pages that follow are audited for
 * their OWN chrome — headings, toolbars, filters, empty states — with their
 * feature components left unresolved (each of those carries its own suite);
 * that is what keeps this file a few hundred milliseconds instead of a minute.
 *
 * QUERIES ANSWER EMPTY ON PURPOSE. The empty state is the branch every new
 * instance opens on, it is the branch with the most bespoke markup (illustration
 * + heading + call to action), and it is the one no screenshot review ever
 * looks at twice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Component } from 'vue';
import {
	auditA11y,
	dashboardShellStubs,
	installNuxtStubs,
	paginatedResult,
	queryResult,
} from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useBulkOperation } from '~/composables/useBulkOperation';
import { useBulkSelection } from '~/composables/useBulkSelection';
import { useCampaignStatusBadge } from '~/composables/useCampaignStatusBadge';
import { useClickOutside } from '~/composables/useClickOutside';
import { useContactBulkOperations } from '~/composables/useContactBulkOperations';
import { useCsvImport } from '~/composables/useCsvImport';
import { useDataTable } from '~/composables/useDataTable';
import { useDebouncedSearch } from '~/composables/useDebouncedSearch';
import { useFormModal } from '~/composables/useFormModal';
import { usePostboxListKeyboard } from '~/composables/postbox/usePostboxListKeyboard';
import { useWizard } from '~/composables/useWizard';
import DashboardLayout from '~/layouts/dashboard.vue';
import DashboardHome from '../index.vue';
import CampaignsIndex from '../campaigns/index.vue';
import CampaignsNew from '../campaigns/new.vue';
import AudienceIndex from '../audience/index.vue';
import ContactsIndex from '../audience/contacts/index.vue';
import SendIndex from '../send/index.vue';
import InboxIndex from '../inbox/index.vue';
import AdminIndex from '../admin/index.vue';
import SettingsIndex from '../preferences/index.vue';
import GettingStarted from '~/components/dashboard/GettingStarted.vue';

// The inbox page imports this composable explicitly rather than by auto-import,
// so a global stub cannot reach it — and the real module builds a BetterAuth
// client that opens a socket to the dev server on import.
vi.mock('~/composables/useOrganization', () => ({
	useOrganization: () => ({
		organization: ref({ id: 'org1', name: 'Owlat' }),
		members: ref([]),
		fetchMembers: vi.fn(),
		isLoading: ref(false),
	}),
}));

beforeEach(() => {
	installNuxtStubs({
		// Extracted surfaces render through vue-i18n; `useI18n` is an auto-import.
		...i18nStubs,
		useRoute: () => ({
			path: '/dashboard',
			fullPath: '/dashboard',
			name: 'dashboard',
			query: {},
			params: {},
			meta: {},
		}),
		// Shell composables — the layout destructures each of these at setup.
		...dashboardShellStubs(),

		// Pure page composables run for real — the markup branches on them, so a
		// stub would audit a page that never renders in the app.
		useBulkOperation,
		useBulkSelection,
		useCampaignStatusBadge,
		useClickOutside,
		useClickOutsideSelector: useClickOutside,
		useContactBulkOperations,
		useCsvImport,
		useDataTable,
		useDebouncedSearch,
		useFormModal,
		usePostboxListKeyboard,
		useWizard,

		// Backend-backed page composables.
		useAdaptiveDashboard: () => ({
			cards: ref([]),
			availableCards: ref([]),
			savedRules: ref([]),
			isLoading: ref(false),
			isEditing: ref(false),
			saveLayout: vi.fn(),
		}),
		useTopicsList: () => ({ results: ref([]), isLoading: ref(false), status: ref('Exhausted') }),
		useInbox: () => ({
			filter: ref('open'),
			sort: ref('newest'),
			toggleSort: vi.fn(),
			filterCounts: ref({}),
			threads: ref([]),
			threadsLoading: ref(false),
			threadsError: ref(null),
			hasMoreThreads: ref(false),
			stats: ref({}),
			loadMoreThreads: vi.fn(),
		}),
		useInboxTriage: () => ({ visible: ref([]), run: vi.fn(), onWindowKeydown: vi.fn() }),
		useOrganization: () => ({
			organization: ref({ id: 'org1', name: 'Owlat' }),
			members: ref([]),
			fetchMembers: vi.fn(),
			isLoading: ref(false),
		}),
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
		useConvexQuery: () => queryResult(undefined),
		useOrganizationQuery: () => queryResult(undefined),
		usePaginatedQuery: () => paginatedResult([]),
	});
});

describe('dashboard shell layout — accessibility', () => {
	it('has no axe violations, landmarks and skip link included', async () => {
		const violations = await auditA11y(DashboardLayout, {
			slots: { default: '<h1>Page under the shell</h1>' },
			// The shell is the one mount that owns a whole document: <main>, the
			// skip link and the landmark structure are all its markup, so it is
			// audited at page scope with the document-scope rules back on.
			pageContext: true,
			// A rail that rendered no destinations would sail through every rule
			// here; the real section list is dozens of links deep.
			prepare: (wrapper) => {
				expect(wrapper.findAll('nav a').length).toBeGreaterThan(3);
				expect(wrapper.find('main#main-content').exists()).toBe(true);
			},
		});
		expect(violations).toEqual([]);
	});
});

interface AuditedPage {
	name: string;
	component: Component;
	/** Copy that only exists once the page finished rendering its loaded state. */
	loaded: string;
	/** False for a page whose title lives in the shell header, not its own body. */
	ownsH1?: boolean;
}

const pages: readonly AuditedPage[] = [
	{ name: 'dashboard home', component: DashboardHome, loaded: 'Welcome back' },
	{ name: 'campaigns list', component: CampaignsIndex, loaded: 'New campaign' },
	{ name: 'new campaign wizard', component: CampaignsNew, loaded: 'Create Campaign' },
	{ name: 'audience overview', component: AudienceIndex, loaded: 'Add Contact' },
	{ name: 'contacts list', component: ContactsIndex, loaded: 'No contacts yet' },
	{ name: 'send overview', component: SendIndex, loaded: 'Templates & blocks' },
	{ name: 'team inbox', component: InboxIndex, loaded: 'Inbox zero' },
	{ name: 'admin overview', component: AdminIndex, loaded: 'Your instance at a glance' },
	// The settings screen is the one page here whose title lives in the shell
	// header rather than in its own body, so it owns h2 sections and no h1.
	{ name: 'settings overview', component: SettingsIndex, loaded: 'Mailboxes', ownsH1: false },
];

describe.each(pages)('$name — accessibility', ({ component, loaded, ownsH1 }) => {
	it('has no axe violations on an empty instance', async () => {
		const violations = await auditA11y(component, {
			// A page that threw or rendered nothing would pass an empty audit.
			prepare: (wrapper) => {
				expect(wrapper.text()).toContain(loaded);
				if (ownsH1 !== false) expect(wrapper.findAll('h1')).toHaveLength(1);
			},
		});
		expect(violations).toEqual([]);
	});
});

describe('getting-started checklist — accessibility', () => {
	it('has no axe violations for an admin on a fresh instance', async () => {
		const violations = await auditA11y(GettingStarted, {
			props: { userId: 'user1', isAdmin: true },
			global: { plugins: [createTestI18n()] },
			prepare: (wrapper) => expect(wrapper.text()).toContain('Getting started'),
		});
		expect(violations).toEqual([]);
	});
});
