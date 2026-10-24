/**
 * ⌘J opens the Assistant for every member — but only while the feature is on.
 * The chord used to navigate unconditionally, so on an instance without the
 * Assistant it led to a page that had nothing to offer.
 *
 * The layout binds ⌘J, ⌘, and ⌘\ as catalog ids through the real dispatcher
 * here, so a remap on the shortcuts page moves them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive, ref } from 'vue';
import { shellComponents, dashboardShellStubs, installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useKeyboardShortcuts } from '~/composables/useKeyboardShortcuts';
import { applyShortcutPreferences, resetShortcutPreferences } from '~/utils/shortcutScope';
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
	resetShortcutPreferences();
	assistantOn = true;
	route.meta = {};
	navigateTo = vi.fn();
	installNuxtStubs({
		...i18nStubs,
		...dashboardShellStubs(),
		useRoute: () => route,
		useBreadcrumbs: () => ({ breadcrumbs: ref([]), setBreadcrumbs: vi.fn() }),
		navigateTo,
		useKeyboardShortcuts,
		useRouter: () => ({ push: vi.fn() }),
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
				LazyAppCommandPalette: true,
				ShellComposerOverlay: true,
				AnswerReviewApproveUndoToast: true,
				LazyKeyboardShortcutsHelp: true,
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

	it('follows a remap of Settings and the Assistant: the new chord opens it, the old one does not', () => {
		applyShortcutPreferences('owlat', [
			{ id: 'global.settings', keys: ['mod+.'] },
			{ id: 'global.assistant', keys: ['mod+u'] },
		]);
		const wrapper = mountLayout();
		pressCmdJ();
		document.dispatchEvent(
			new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true })
		);
		expect(navigateTo).not.toHaveBeenCalled();
		document.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'u', metaKey: true, bubbles: true })
		);
		document.dispatchEvent(
			new KeyboardEvent('keydown', { key: '.', ctrlKey: true, bubbles: true })
		);
		expect(navigateTo.mock.calls).toEqual([['/dashboard/assistant'], ['/dashboard/preferences']]);
		wrapper.unmount();
	});

	it('leaves the chord to the draft inside Answer mode', () => {
		route.meta = { answerMode: true };
		const wrapper = mountLayout();
		pressCmdJ();
		expect(navigateTo).not.toHaveBeenCalledWith('/dashboard/assistant');
		wrapper.unmount();
	});
});

describe('dashboard layout — Answer mode chrome', () => {
	it('hides the shell header and sends the sidebar off-screen, as focus mode does', () => {
		route.meta = { answerMode: true };
		const wrapper = mountLayout();
		expect(wrapper.findComponent({ name: 'DashboardShellHeader' }).exists()).toBe(false);
		const aside = wrapper.get('aside');
		expect(aside.classes()).toContain('lg:-translate-x-full');
		expect(aside.attributes('inert')).toBeDefined();
		wrapper.unmount();
	});

	it('keeps the header on every other page', () => {
		const wrapper = mountLayout();
		expect(wrapper.findComponent({ name: 'DashboardShellHeader' }).exists()).toBe(true);
		wrapper.unmount();
	});
});
