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

	it('keeps valid per-workspace entries and drops junk ones', () => {
		const s = normalizeDesktopSettings({
			workspaces: {
				'ws-1': { muteNotifications: true },
				'ws-2': { muteNotifications: 'loud' },
				'ws-3': 'not-an-object',
			},
		});
		expect(s.workspaces['ws-1']).toEqual({ muteNotifications: true });
		expect(s.workspaces['ws-2']).toEqual({ muteNotifications: false });
		expect(s.workspaces['ws-3']).toBeUndefined();
	});

	it('round-trips a fully-populated settings object unchanged', () => {
		const full = {
			version: SETTINGS_VERSION,
			global: {
				autoCheckUpdates: false,
				notificationsEnabled: false,
				showUnreadBadge: false,
				startupWorkspaceId: 'ws-9',
			},
			workspaces: { 'ws-9': { muteNotifications: true } },
		};
		expect(normalizeDesktopSettings(full)).toEqual(full);
	});
});
