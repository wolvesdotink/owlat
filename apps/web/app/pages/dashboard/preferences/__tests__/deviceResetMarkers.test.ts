/**
 * Reset to default on Preferences → This device (desktop app): the
 * notification and badge switches, the startup workspace and each workspace's
 * mute compare against the defaults a missing settings file is read as, stay
 * unmarked until the store has loaded, and Reset writes that default back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { defaultDesktopSettings } from '~/lib/desktop/settingsTypes';
import DevicePage from '../device.vue';

const WORKSPACES = [
	{ id: 'w1', label: 'Owlat', siteUrl: 'https://owlat.example', accentColor: '#7a8c5a' },
];

const setGlobal = vi.fn();
const setWorkspaceLocal = vi.fn();
let global: ReturnType<typeof defaultDesktopSettings>['global'];
let muted: boolean;
let isReady: boolean;

beforeEach(() => {
	setGlobal.mockClear();
	setWorkspaceLocal.mockClear();
	global = defaultDesktopSettings().global;
	muted = false;
	isReady = true;
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useHead', () => {});
	vi.stubGlobal('definePageMeta', () => {});
	vi.stubGlobal('navigateTo', vi.fn());
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(true), platform: ref('linux') }));
	vi.stubGlobal('useDesktopAppSettings', () => ({
		settings: ref({ global }),
		isReady: ref(isReady),
		setGlobal,
		workspaceLocal: () => ({ muteNotifications: muted }),
		setWorkspaceLocal,
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
		removeWorkspace: vi.fn(),
		abandonRemoval: vi.fn(),
		createRemovalOwner: () => ({ release: vi.fn() }),
		setWorkspaceAccent: vi.fn(),
	}));
});

function mountPage() {
	return mount(DevicePage, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiButton: true,
				UiConfirmationDialog: true,
				UiSwitch: true,
				I18nT: true,
				PreferencesWebPush: true,
				PreferencesMarketingNotifications: true,
				PostboxAlertSoundSettings: true,
				PostboxOfflineSettings: true,
				PostboxNotificationSettings: true,
				DesktopUpdateCard: true,
				DesktopWorkspaceAccentPicker: true,
			},
		},
	});
}

const markers = (page: ReturnType<typeof mountPage>) =>
	page
		.findAll('[data-testid="setting-reset"] button')
		.map((button) => button.attributes('aria-label'));

describe('Preferences → This device: reset to default', () => {
	it('marks nothing on a fresh device', () => {
		expect(markers(mountPage())).toEqual([]);
	});

	it('marks each changed device setting by name', () => {
		global = {
			...global,
			notificationsEnabled: false,
			showUnreadBadge: false,
			startupWorkspaceId: 'w1',
		};
		muted = true;
		expect(markers(mountPage())).toEqual([
			'Reset Desktop notifications to its default',
			'Reset Unread badge to its default',
			'Reset Open at startup to its default',
			'Reset Mute notifications for Owlat to its default',
		]);
	});

	it('marks nothing until the settings store has loaded', () => {
		global = { ...global, notificationsEnabled: false };
		muted = true;
		isReady = false;
		expect(markers(mountPage())).toEqual([]);
	});

	it('writes the defaults back on Reset', async () => {
		global = { ...global, notificationsEnabled: false, startupWorkspaceId: 'w1' };
		muted = true;
		const page = mountPage();
		for (const button of page.findAll('[data-testid="setting-reset"] button')) {
			await button.trigger('click');
		}
		expect(setGlobal).toHaveBeenCalledWith('notificationsEnabled', true);
		expect(setGlobal).toHaveBeenCalledWith('startupWorkspaceId', null);
		expect(setWorkspaceLocal).toHaveBeenCalledWith('w1', 'muteNotifications', false);
	});
});
