import { describe, it, expect } from 'vitest';
import { desktopPlatformFrom, osNotificationSettingsUri } from '../notificationPermission';

describe('desktopPlatformFrom', () => {
	it('reads the three targets we ship out of navigator.platform', () => {
		expect(desktopPlatformFrom('MacIntel')).toBe('mac');
		expect(desktopPlatformFrom('Win32')).toBe('windows');
		expect(desktopPlatformFrom('Linux x86_64')).toBe('linux');
	});

	it('falls back to linux for anything unrecognised', () => {
		// Better a missing deep link (we render instructions) than a wrong one.
		expect(desktopPlatformFrom('')).toBe('linux');
		expect(desktopPlatformFrom('FreeBSD amd64')).toBe('linux');
	});
});

describe('osNotificationSettingsUri', () => {
	it('deep-links the notification pane on macOS and Windows', () => {
		expect(osNotificationSettingsUri('mac')).toBe(
			'x-apple.systempreferences:com.apple.preference.notifications'
		);
		expect(osNotificationSettingsUri('windows')).toBe('ms-settings:notifications');
	});

	it('has no single pane to link on Linux', () => {
		expect(osNotificationSettingsUri('linux')).toBeNull();
	});

	it('only emits URIs the desktop shell scope allows', () => {
		// Mirrors plugins.shell.open in apps/desktop/src-tauri/tauri.conf.json —
		// a URI outside that regex would be refused at runtime, silently.
		const allowed =
			/^((mailto:\w+)|(tel:\w+)|(https?:\/\/\w+)|(ms-settings:)|(x-apple\.systempreferences:)).+/;
		for (const platform of ['mac', 'windows'] as const) {
			expect(allowed.test(osNotificationSettingsUri(platform)!)).toBe(true);
		}
	});
});
