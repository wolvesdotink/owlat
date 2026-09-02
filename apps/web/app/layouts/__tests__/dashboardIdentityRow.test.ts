// @vitest-environment happy-dom
/**
 * THE SIDEBAR'S TWO QUIETEST PROMISES: HONEST PENDING, AND ONE ACCENT.
 *
 * The identity row is the shell's most persistent loading state — it is on
 * screen at every cold boot of every page — and it used to render a literal
 * "..." inside the avatar circle plus an empty second line, which reads as a
 * broken glyph and then jumps when the session lands. It is now a skeleton at
 * the row's exact geometry, which is aria-hidden, so the trigger keeps its
 * accessible name from an sr-only label instead of the text it no longer has.
 *
 * The rail's selection recipe is asserted here too. DESIGN-LANGUAGE.md rule 1
 * allows terracotta in small quantities only, and the rail used to paint the
 * context toggle, the Home link, flat sections AND sub-items with
 * `bg-brand-subtle text-brand` at once. Selection is now the neutral surface
 * ladder plus weight; the one brand accent left is the active leaf's icon.
 * Mounted rather than grepped, because what matters is the class the ACTIVE
 * branch resolves to, not the one written in the file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import UiSkeleton from '@owlat/ui/components/ui/Skeleton.vue';
import { dashboardShellStubs, installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import DashboardLayout from '../dashboard.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const route = reactive({
	path: '/dashboard',
	fullPath: '/dashboard',
	name: 'dashboard',
	params: {} as Record<string, string>,
	query: {} as Record<string, string>,
	hash: '',
	meta: {},
});

/** The session the layout reads, flipped between pending and resolved. */
function authStub(pending: boolean): Record<string, unknown> {
	return {
		useAuth: () => ({
			user: ref(pending ? null : { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com' }),
			sessionData: ref(null),
			status: ref(pending ? 'pending' : 'authenticated'),
			isAuthenticated: ref(!pending),
			isPending: ref(pending),
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
	};
}

beforeEach(() => {
	route.path = '/dashboard';
	route.fullPath = '/dashboard';
	document.body.innerHTML = '';
});

function mountLayout(pending = false): VueWrapper {
	installNuxtStubs({
		...i18nStubs,
		...dashboardShellStubs(),
		...authStub(pending),
		useRoute: () => route,
		useBreadcrumbs: () => ({ breadcrumbs: ref([]), setBreadcrumbs: vi.fn() }),
	});
	return mount(DashboardLayout, {
		attachTo: document.body,
		slots: { default: '<h1>Page under the shell</h1>' },
		global: {
			plugins: [createTestI18n()],
			// Real, not stubbed: the pending row IS a skeleton, so stubbing it
			// away would leave nothing to assert about.
			components: { UiSkeleton },
			stubs: {
				DesktopTitlebar: true,
				DashboardShellHeader: true,
				AppCommandPalette: true,
				KeyboardShortcutsHelp: true,
				QueryQuickQueryPanel: true,
				AppLiveRegion: true,
				Icon: true,
				UiBadge: true,
				UiThemeToggle: true,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
			},
		},
	});
}

/**
 * The identity trigger: the last button in the rail, below the theme toggle.
 * Matched by content rather than position — a skeleton while pending, the
 * user's initials once resolved — so a new footer row cannot silently retarget
 * these assertions.
 */
function identityButton(): HTMLElement {
	const buttons = [...document.querySelectorAll('aside button')];
	const row = buttons.find(
		(candidate) =>
			candidate.querySelector('.ui-skeleton') !== null ||
			(candidate.textContent ?? '').includes('Ada Lovelace')
	);
	expect(row, 'identity row not found in the rail').toBeTruthy();
	return row as HTMLElement;
}

describe('dashboard sidebar — identity row', () => {
	it('renders skeletons, not a "..." glyph, while the session resolves', () => {
		const wrapper = mountLayout(true);
		const row = identityButton();

		expect(row.textContent).not.toContain('...');
		// Avatar circle plus the two text lines it stands in for, so the row
		// keeps its height when the name lands.
		expect(row.querySelectorAll('.ui-skeleton')).toHaveLength(3);
		wrapper.unmount();
	});

	it('keeps the pending trigger named even though the skeleton is aria-hidden', () => {
		const wrapper = mountLayout(true);
		const row = identityButton();

		expect(row.getAttribute('aria-busy')).toBe('true');
		// UiSkeleton is aria-hidden; without the sr-only label the button would
		// have no accessible name at all during the pending window.
		expect(row.querySelector('.sr-only')?.textContent?.trim()).toBeTruthy();
		wrapper.unmount();
	});

	it('shows initials and the real name once the session lands', () => {
		const wrapper = mountLayout(false);
		const row = identityButton();

		expect(row.querySelectorAll('.ui-skeleton')).toHaveLength(0);
		expect(row.textContent).toContain('AL');
		expect(row.textContent).toContain('Ada Lovelace');
		expect(row.getAttribute('aria-busy')).toBeNull();
		wrapper.unmount();
	});

	it('tones the avatar neutral instead of making identity a third brand chip', () => {
		const wrapper = mountLayout(false);
		const avatar = identityButton().querySelector('.rounded-full');

		expect(avatar?.textContent?.trim()).toBe('AL');
		expect(avatar?.className).not.toContain('brand');
		wrapper.unmount();
	});
});

describe('dashboard sidebar — one accent', () => {
	it('selects with the neutral surface ladder, not a terracotta pill', () => {
		const wrapper = mountLayout(false);

		// The Home link is active at /dashboard; it is the widest selection
		// recipe in the rail and used to be `bg-brand-subtle text-brand`.
		const home = document.querySelector('aside nav a[href="/dashboard"]');
		expect(home?.className).toContain('bg-(--surface-2-selected)');
		expect(home?.className).toContain('text-text-primary');
		expect(home?.className).not.toContain('bg-brand-subtle');
		wrapper.unmount();
	});

	it('leaves no brand-filled element anywhere in the rail', () => {
		const wrapper = mountLayout(false);

		const filled = [...document.querySelectorAll('aside [class*="bg-brand"]')];
		expect(filled.map((element) => element.className)).toEqual([]);
		wrapper.unmount();
	});
});
