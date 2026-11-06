/**
 * `normalizeDesktopSettings` is the resilience contract for settings.json: a
 * missing, corrupt, partially-written, or future-versioned store must always
 * yield a complete, typed settings object — one bad key can never take the
 * rest of the settings (or the boot path that reads them) down.
 */
import { describe, it, expect } from 'vitest';
import {
	defaultDesktopSettings,
	normalizeDesktopSettings,
	SETTINGS_VERSION,
} from '../settingsTypes';

describe('normalizeDesktopSettings', () => {
	it('returns pristine defaults for a missing store (null)', () => {
		expect(normalizeDesktopSettings(null)).toEqual(defaultDesktopSettings());
	});

	it('returns defaults for junk top-level values', () => {
		for (const junk of [undefined, 42, 'state', true, []]) {
			expect(normalizeDesktopSettings(junk)).toEqual(defaultDesktopSettings());
		}
	});

	it('merges a partial global over the defaults', () => {
		const s = normalizeDesktopSettings({ global: { autoCheckUpdates: false } });
		expect(s.global.autoCheckUpdates).toBe(false);
		// Untouched fields keep their defaults.
		expect(s.global.notificationsEnabled).toBe(true);
		expect(s.global.showUnreadBadge).toBe(true);
		expect(s.global.startupWorkspaceId).toBeNull();
		expect(s.version).toBe(SETTINGS_VERSION);
	});

	it('falls back per-field when a value has the wrong type', () => {
		const s = normalizeDesktopSettings({
			global: {
				autoCheckUpdates: 'yes',
				notificationsEnabled: false,
				startupWorkspaceId: 7,
			},
		});
		expect(s.global.autoCheckUpdates).toBe(true); // junk → default
		expect(s.global.notificationsEnabled).toBe(false); // valid → kept
		expect(s.global.startupWorkspaceId).toBeNull(); // junk → default
	});

	it('shows the tray icon and closes to it unless the file says otherwise', () => {
		expect(normalizeDesktopSettings({ global: {} }).global).toMatchObject({
			showTrayIcon: true,
			closeToTray: true,
		});
		const s = normalizeDesktopSettings({ global: { showTrayIcon: 'off', closeToTray: false } });
		expect(s.global.showTrayIcon).toBe(true);
		expect(s.global.closeToTray).toBe(false);
	});

	it('keeps the Dock icon unless the file asks to hide it', () => {
		expect(normalizeDesktopSettings({ global: {} }).global.hideDockIcon).toBe(false);
		expect(normalizeDesktopSettings({ global: { hideDockIcon: true } }).global.hideDockIcon).toBe(
			true
		);
		expect(normalizeDesktopSettings({ global: { hideDockIcon: 'yes' } }).global.hideDockIcon).toBe(
			false
		);
	});

	it('counts all inboxes in the tray unless a workspace names one mailbox', () => {
		const s = normalizeDesktopSettings({
			workspaces: {
				'ws-1': { trayMailboxId: 'mb-1' },
				'ws-2': { trayMailboxId: 42 },
				'ws-3': { trayMailboxId: '' },
			},
		});
		expect(s.workspaces['ws-1']?.trayMailboxId).toBe('mb-1');
		expect(s.workspaces['ws-2']?.trayMailboxId).toBeNull();
		expect(s.workspaces['ws-3']?.trayMailboxId).toBeNull();
	});

	it('keeps valid per-workspace entries and drops junk ones', () => {
		const s = normalizeDesktopSettings({
			workspaces: {
				'ws-1': { muteNotifications: true },
				'ws-2': { muteNotifications: 'loud' },
				'ws-3': 'not-an-object',
			},
		});
		expect(s.workspaces['ws-1']).toEqual({ muteNotifications: true, trayMailboxId: null });
		expect(s.workspaces['ws-2']).toEqual({ muteNotifications: false, trayMailboxId: null });
		expect(s.workspaces['ws-3']).toBeUndefined();
	});

	it('round-trips a fully-populated settings object unchanged', () => {
		const full = {
			version: SETTINGS_VERSION,
			global: {
				autoCheckUpdates: false,
				notificationsEnabled: false,
				showUnreadBadge: false,
				showTrayIcon: false,
				closeToTray: false,
				hideDockIcon: true,
				startupWorkspaceId: 'ws-9',
			},
			workspaces: { 'ws-9': { muteNotifications: true, trayMailboxId: 'mb-9' } },
		};
		expect(normalizeDesktopSettings(full)).toEqual(full);
	});
});
