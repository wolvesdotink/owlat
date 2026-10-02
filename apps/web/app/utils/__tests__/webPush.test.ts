import { describe, expect, it } from 'vitest';
import {
	applicationServerKeyBytes,
	describeDevice,
	isAppleMobile,
	subscriptionMatchesKey,
	webPushStatusKey,
	webPushSupport,
	type WebPushEnvironment,
} from '../webPush';

const UA = {
	chromeMac:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
	safariIphone:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
	safariIpadDesktopMode:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
	firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
	edgeWindows:
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
	chromeAndroid:
		'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
};

function env(overrides: Partial<WebPushEnvironment> = {}): WebPushEnvironment {
	return {
		hasServiceWorker: true,
		hasPushManager: true,
		hasNotification: true,
		isSecureContext: true,
		userAgent: UA.chromeMac,
		maxTouchPoints: 0,
		isStandalone: false,
		...overrides,
	};
}

describe('webPushSupport', () => {
	it('is supported in a desktop browser with the push APIs', () => {
		expect(webPushSupport(env())).toBe('supported');
	});

	it('asks iPhone and iPad tabs to install first, even though the APIs are missing there', () => {
		const iphoneTab = env({ userAgent: UA.safariIphone, hasPushManager: false });
		expect(webPushSupport(iphoneTab)).toBe('needs-home-screen');
		const ipad = env({ userAgent: UA.safariIpadDesktopMode, maxTouchPoints: 5 });
		expect(webPushSupport(ipad)).toBe('needs-home-screen');
		expect(webPushSupport({ ...iphoneTab, isStandalone: true, hasPushManager: true })).toBe(
			'supported'
		);
	});

	it('is unsupported without a secure context or the push APIs', () => {
		expect(webPushSupport(env({ isSecureContext: false }))).toBe('unsupported');
		expect(webPushSupport(env({ hasPushManager: false }))).toBe('unsupported');
		expect(webPushSupport(env({ hasNotification: false }))).toBe('unsupported');
	});

	it('tells a touch Mac (iPad) apart from a real Mac', () => {
		expect(isAppleMobile(UA.safariIpadDesktopMode, 5)).toBe(true);
		expect(isAppleMobile(UA.safariIpadDesktopMode, 0)).toBe(false);
	});
});

describe('describeDevice', () => {
	it.each([
		[UA.chromeMac, 0, 'Chrome on macOS'],
		[UA.safariIphone, 5, 'Safari on iPhone'],
		[UA.safariIpadDesktopMode, 5, 'Safari on iPad'],
		[UA.firefoxLinux, 0, 'Firefox on Linux'],
		[UA.edgeWindows, 0, 'Edge on Windows'],
		[UA.chromeAndroid, 5, 'Chrome on Android'],
		['curl/8.0', 0, 'Browser'],
	])('labels %s', (userAgent, touch, label) => {
		expect(describeDevice(userAgent, touch)).toBe(label);
	});
});

describe('applicationServerKeyBytes / subscriptionMatchesKey', () => {
	const key =
		'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';

	it('decodes an unpadded base64url VAPID key to the 65-byte point', () => {
		const bytes = applicationServerKeyBytes(key);
		expect(bytes).toHaveLength(65);
		expect(bytes[0]).toBe(0x04);
	});

	it('recognises a subscription made with another key (rotated VAPID pair)', () => {
		const same = applicationServerKeyBytes(key).buffer;
		const other = new Uint8Array(65).fill(4).buffer;
		expect(subscriptionMatchesKey(same, key)).toBe(true);
		expect(subscriptionMatchesKey(other, key)).toBe(false);
		expect(subscriptionMatchesKey(null, key)).toBe(true);
	});
});

describe('webPushStatusKey', () => {
	const base = {
		support: 'supported' as const,
		permission: 'default' as const,
		isEnabledHere: false,
	};
	it('names the state the device is in', () => {
		expect(webPushStatusKey(base)).toMatch(/status\.off$/);
		expect(webPushStatusKey({ ...base, permission: 'granted', isEnabledHere: true })).toMatch(
			/status\.on$/
		);
		expect(webPushStatusKey({ ...base, permission: 'denied' })).toMatch(/status\.blocked$/);
		expect(webPushStatusKey({ ...base, support: 'needs-home-screen' })).toMatch(
			/status\.needsHomeScreen$/
		);
		expect(webPushStatusKey({ ...base, support: 'unsupported' })).toMatch(/status\.unsupported$/);
	});
});
