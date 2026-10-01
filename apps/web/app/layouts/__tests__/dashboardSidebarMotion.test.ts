// @vitest-environment happy-dom
/**
 * Collapsing the sidebar must not relay the app out on every frame.
 *
 * The rail's width and the content's left padding both carried
 * `transition-all`, so a collapse animated `width` and `padding-left` and the
 * browser laid out the whole page (Postbox, reader frames and all) for each
 * frame of the move. Now the width and the padding swap in one frame and only
 * the rail's `translate` (hide, peek, mobile drawer) and the peek's shadow
 * animate. Reduced motion drops even that. The collapse button still toggles
 * the same persisted preference.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, reactive, ref } from 'vue';
import { dashboardShellStubs, installNuxtStubs, shellComponents } from '~/__tests__/a11y';
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
	path: '/dashboard/campaigns',
	fullPath: '/dashboard/campaigns',
	name: 'dashboard-campaigns',
	params: {},
	query: {},
	hash: '',
	meta: {},
});

const collapsed = ref(false);
const toggleCollapsed = vi.fn(() => {
	collapsed.value = !collapsed.value;
});

let wrapper: VueWrapper | null = null;

beforeEach(() => {
	collapsed.value = false;
	toggleCollapsed.mockClear();
	document.body.innerHTML = '';
	const shell = dashboardShellStubs();
	const sidebarState = (shell.useSidebarState as () => Record<string, unknown>)();
	installNuxtStubs({
		...i18nStubs,
		...shell,
		useSidebarState: () => ({
			...sidebarState,
			isCollapsed: collapsed,
			effectiveCollapsed: collapsed,
			toggleCollapsed,
		}),
		useRoute: () => route,
		useBreadcrumbs: () => ({ breadcrumbs: ref([]), setBreadcrumbs: vi.fn() }),
	});
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	document.body.innerHTML = '';
});

function mountLayout(): VueWrapper {
	wrapper = mount(DashboardLayout, {
		attachTo: document.body,
		slots: { default: '<h1>Page under the shell</h1>' },
		global: {
			plugins: [createTestI18n()],
			components: { ...shellComponents },
			stubs: {
				DesktopTitlebar: true,
				DashboardShellHeader: true,
				LazyAppCommandPalette: true,
				ShellComposerOverlay: true,
				AnswerReviewApproveUndoToast: true,
				LazyKeyboardShortcutsHelp: true,
				QueryQuickQueryPanel: true,
				AppLiveRegion: true,
				Icon: true,
				UiBadge: true,
				UiSkeleton: true,
				UiThemeToggle: true,
				UiDropdownMenu: true,
				UiDropdownMenuItem: true,
				UiDropdownDivider: true,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
			},
		},
	});
	return wrapper;
}

const rail = () => document.querySelector('aside') as HTMLElement;
/** The wrapper that carries the content's left gutter: `<main>`'s parent. */
const content = () => document.getElementById('main-content')?.parentElement as HTMLElement;
const transitionClasses = (el: HTMLElement) =>
	[...el.classList].filter((name) => /(^|:)transition(-|$)/.test(name));

describe('dashboard layout — sidebar motion', () => {
	it('animates only the rail translate (and peek shadow), never its width', () => {
		mountLayout();
		expect(transitionClasses(rail())).toEqual([
			'transition-[translate,box-shadow]',
			'motion-reduce:transition-none',
		]);
	});

	it('never transitions the content padding', () => {
		mountLayout();
		expect(content().classList.contains('lg:pl-64')).toBe(true);
		expect(transitionClasses(content())).toEqual([]);
		expect([...content().classList].some((name) => name.startsWith('duration-'))).toBe(false);
	});

	it('collapses rail width and content gutter together through the same toggle', async () => {
		mountLayout();
		expect(rail().classList.contains('w-64')).toBe(true);

		const toggle = [...rail().querySelectorAll('button')].find(
			(button) => button.getAttribute('title') === 'Collapse sidebar'
		);
		expect(toggle, 'collapse toggle not found').toBeTruthy();
		toggle?.click();
		await nextTick();

		expect(toggleCollapsed).toHaveBeenCalledTimes(1);
		expect(rail().classList.contains('w-16')).toBe(true);
		expect(content().classList.contains('lg:pl-16')).toBe(true);
		expect(content().classList.contains('lg:pl-64')).toBe(false);
	});
});
