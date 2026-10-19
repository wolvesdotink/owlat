// @vitest-environment happy-dom
/**
 * The workspace-removal dialog on Preferences → This device, when the removal
 * rejects part-way (the offline cache, keychain access or the store save).
 *
 * The removal navigates away on success, so the dialog used to stay in its
 * loading state and wait for that; a rejection left it spinning for good with
 * Cancel disabled. What is pinned: a rejection ends the loading state, says the
 * removal did not finish, and leaves both Cancel and a Retry that runs the
 * removal again; a success keeps the dialog loading until the page goes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import UiConfirmationDialog from '@owlat/ui/components/ui/ConfirmationDialog.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import DevicePage from '../device.vue';

const UiModalStub = defineComponent({
	props: { open: Boolean, persistent: Boolean, closable: Boolean },
	emits: ['update:open'],
	setup(props, { slots, emit }) {
		return () =>
			props.open
				? h('div', { class: 'modal', role: 'dialog' }, [
						h(
							'button',
							{
								class: 'backdrop',
								onClick: () => !props.persistent && emit('update:open', false),
							},
							'x'
						),
						h('div', { class: 'body' }, slots.default?.()),
						h('div', { class: 'footer' }, slots.footer?.()),
					])
				: null;
	},
});

const UiButtonStub = defineComponent({
	props: { variant: String, disabled: Boolean, loading: Boolean, size: String, to: String },
	setup(props, { slots }) {
		return () =>
			h(
				'button',
				{
					class: ['ui-button', `ui-button--${props.variant}`],
					disabled: props.disabled || props.loading,
				},
				[slots.iconLeft?.(), slots.default?.()]
			);
	},
});

const WORKSPACES = [
	{ id: 'w1', label: 'Owlat', siteUrl: 'https://owlat.example', accentColor: '#7a8c5a' },
	{
		id: 'w2',
		label: 'Owlat Staging',
		siteUrl: 'https://staging.owlat.example',
		accentColor: '#c2703d',
	},
];

const removeWorkspace = vi.fn<(id: string) => Promise<void>>();

beforeEach(() => {
	removeWorkspace.mockReset();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useHead', () => {});
	vi.stubGlobal('definePageMeta', () => {});
	vi.stubGlobal('navigateTo', vi.fn());
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(true), platform: ref('linux') }));
	vi.stubGlobal('useDesktopAppSettings', () => ({
		settings: ref({ global: { notificationsEnabled: true, showUnreadBadge: true } }),
		isReady: ref(true),
		setGlobal: vi.fn(),
		workspaceLocal: () => ({ muteNotifications: false }),
		setWorkspaceLocal: vi.fn(),
	}));
	vi.stubGlobal('useDesktopSettings', () => ({
		autostartEnabled: ref(false),
		isReady: ref(true),
		setAutostart: vi.fn(),
	}));
	vi.stubGlobal('useDesktopWorkspaces', () => ({
		workspaces: ref(WORKSPACES),
		activeId: ref('w1'),
		switchTo: vi.fn(),
		removeWorkspace,
		setWorkspaceAccent: vi.fn(),
	}));
});

function mountPage() {
	return mount(DevicePage, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: { UiConfirmationDialog },
			stubs: {
				UiModal: UiModalStub,
				UiButton: UiButtonStub,
				Icon: true,
				UiSwitch: true,
				I18nT: true,
				PreferencesWebPush: true,
				PostboxOfflineSettings: true,
				PostboxNotificationSettings: true,
				DesktopUpdateCard: true,
			},
		},
	});
}

type Page = ReturnType<typeof mountPage>;
const dialog = (w: Page) => w.find('.modal');
const confirmButton = (w: Page) => w.find('.footer button.ui-button--danger');
const cancelButton = (w: Page) => w.find('.footer button.ui-button--secondary');
const alert = (w: Page) => w.find('.modal [role="alert"]');

async function openRemoval(w: Page, index = 1) {
	const removeButtons = w.findAll('#workspaces li button').filter((b) => b.text() === 'Remove');
	await removeButtons[index]!.trigger('click');
}

const FAILED = "Removing the workspace didn't finish.";

describe('Preferences → This device: removing a workspace', () => {
	it('ends the loading state when the removal rejects, keeping Cancel and offering Retry', async () => {
		removeWorkspace.mockRejectedValueOnce(new Error('Keychain access was denied'));
		const w = mountPage();
		await openRemoval(w);
		expect(dialog(w).text()).toContain('Remove Owlat Staging from this device?');
		expect(alert(w).exists()).toBe(false);

		await confirmButton(w).trigger('click');
		await flushPromises();

		expect(removeWorkspace).toHaveBeenCalledWith('w2');
		expect(alert(w).text()).toContain(FAILED);
		expect(confirmButton(w).text()).toBe('Try again');
		expect(confirmButton(w).attributes('disabled')).toBeUndefined();
		expect(cancelButton(w).attributes('disabled')).toBeUndefined();
		w.unmount();
	});

	it('closes on Cancel after a failed attempt and opens clean the next time', async () => {
		removeWorkspace.mockRejectedValueOnce(new Error('store save failed'));
		const w = mountPage();
		await openRemoval(w);
		await confirmButton(w).trigger('click');
		await flushPromises();

		await cancelButton(w).trigger('click');
		expect(dialog(w).exists()).toBe(false);

		await openRemoval(w, 0);
		expect(dialog(w).text()).toContain('Remove Owlat from this device?');
		expect(alert(w).exists()).toBe(false);
		expect(confirmButton(w).text()).toBe('Remove workspace');
		w.unmount();
	});

	it('runs the removal again on Retry and stays loading once it succeeds', async () => {
		removeWorkspace.mockRejectedValueOnce(new Error('offline cache wipe failed'));
		removeWorkspace.mockResolvedValueOnce(undefined);
		const w = mountPage();
		await openRemoval(w);
		await confirmButton(w).trigger('click');
		await flushPromises();

		await confirmButton(w).trigger('click');
		// The error clears while the retry runs.
		await nextTick();
		expect(alert(w).exists()).toBe(false);
		await flushPromises();

		expect(removeWorkspace).toHaveBeenCalledTimes(2);
		expect(removeWorkspace).toHaveBeenNthCalledWith(2, 'w2');
		// Success navigates away: the dialog waits for that in its loading state.
		expect(alert(w).exists()).toBe(false);
		expect(cancelButton(w).attributes('disabled')).toBeDefined();
		expect(confirmButton(w).attributes('disabled')).toBeDefined();
		w.unmount();
	});

	it('starts one removal however often confirm is pressed while it runs', async () => {
		let finish!: () => void;
		removeWorkspace.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);
		const w = mountPage();
		await openRemoval(w);

		await confirmButton(w).trigger('click');
		// Fired as events, past the disabled button, to reach the handler itself.
		w.findComponent(UiConfirmationDialog).vm.$emit('confirm');
		w.findComponent(UiConfirmationDialog).vm.$emit('confirm');
		finish();
		await flushPromises();

		expect(removeWorkspace).toHaveBeenCalledTimes(1);
		w.unmount();
	});
});
