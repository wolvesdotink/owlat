// @vitest-environment happy-dom
/**
 * ⌘J opens the Assistant for every member — but only while the feature is on.
 * The chord used to navigate unconditionally, so on an instance without the
 * Assistant it led to a page that had nothing to offer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';
import { shellComponents, dashboardShellStubs, installNuxtStubs } from '~/__tests__/a11y';
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
	params: {},
	query: {},
	hash: '',
	meta: {},
});

let assistantOn: boolean;
let navigateTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
	assistantOn = true;
	navigateTo = vi.fn();
	document.body.innerHTML = '';
	installNuxtStubs({
		...i18nStubs,
		...dashboardShellStubs(),
		useRoute: () => route,
		useBreadcrumbs: () => ({ breadcrumbs: ref([]), setBreadcrumbs: vi.fn() }),
		navigateTo,
		useFeatureFlag: () => ({
			flags: ref({}),
			isEnabled: (flag: string) => flag !== 'ai.assistant' || assistantOn,
			isLoading: ref(false),
			error: ref(null),
		}),
	});
});

function mountLayout() {
	return mount(DashboardLayout, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			mocks: { resolveComponent: (name: string) => name },
			components: { ...shellComponents },
			stubs: {
				DesktopTitlebar: true,
				DashboardShellHeader: true,
				AppCommandPalette: true,
				ShellComposerOverlay: true,
				KeyboardShortcutsHelp: true,
				AppLiveRegion: true,
				Icon: true,
				UiBadge: true,
				UiSkeleton: true,
				UiThemeToggle: true,
				NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
			},
		},
	});
}

const pressCmdJ = () =>
	document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true, bubbles: true }));

describe('dashboard layout — ⌘J', () => {
	it('opens the Assistant while the feature is on', () => {
		const wrapper = mountLayout();
		pressCmdJ();
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/assistant');
		wrapper.unmount();
	});

	it('does nothing while the feature is off', () => {
		assistantOn = false;
		const wrapper = mountLayout();
		pressCmdJ();
		expect(navigateTo).not.toHaveBeenCalledWith('/dashboard/assistant');
		wrapper.unmount();
	});
});
