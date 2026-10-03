/**
 * Pure decisions behind Preferences → This device → Push notifications, kept
 * out of the composable so they are testable without a browser:
 *
 *   - {@link webPushSupport} — can this browser get push at all, and if not,
 *     what would make it (iOS and iPadOS only deliver Web Push to a site added
 *     to the Home Screen and opened from there).
 *   - {@link describeDevice} — the "Chrome on macOS" label the device list
 *     shows. Derived here, in the browser, so the server never stores a raw
 *     user-agent string.
 *   - {@link applicationServerKeyBytes} — the VAPID public key in the form
 *     `PushManager.subscribe` takes.
 *
 * Copy travels as i18n KEYS (module-scope registry convention).
 */

export type WebPushSupport =
	/** Service worker, PushManager and Notification are all there. */
	| 'supported'
	/** iPhone / iPad in a browser tab: works once added to the Home Screen. */
	| 'needs-home-screen'
	/** This browser has no Web Push (or it is not a secure context). */
	| 'unsupported';

export interface WebPushEnvironment {
	hasServiceWorker: boolean;
	hasPushManager: boolean;
	hasNotification: boolean;
	isSecureContext: boolean;
	userAgent: string;
	/** `navigator.maxTouchPoints` — tells an iPad (which claims to be a Mac) apart. */
	maxTouchPoints: number;
	/** `display-mode: standalone` or `navigator.standalone`: opened from the Home Screen. */
	isStandalone: boolean;
}

/** iPhone, iPod or iPad — including iPadOS, which reports a desktop Safari UA. */
export function isAppleMobile(userAgent: string, maxTouchPoints: number): boolean {
	if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
	return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

export function webPushSupport(env: WebPushEnvironment): WebPushSupport {
	const apple = isAppleMobile(env.userAgent, env.maxTouchPoints);
	// On iOS the push APIs only exist inside the installed web app, so their
	// absence in a tab means "install first", not "never".
	if (apple && !env.isStandalone) return 'needs-home-screen';
	if (!env.isSecureContext) return 'unsupported';
	if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported';
	return 'supported';
}

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
	[/Edg(e|A|iOS)?\//, 'Edge'],
	[/OPR\/|Opera/, 'Opera'],
	[/SamsungBrowser\//, 'Samsung Internet'],
	[/Firefox\/|FxiOS\//, 'Firefox'],
	[/Chrome\/|CriOS\//, 'Chrome'],
	[/Safari\//, 'Safari'],
];

const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
	[/iPhone|iPod/, 'iPhone'],
	[/iPad/, 'iPad'],
	[/Android/, 'Android'],
	[/CrOS/, 'ChromeOS'],
	[/Windows/, 'Windows'],
	[/Macintosh|Mac OS X/, 'macOS'],
	[/Linux/, 'Linux'],
];

/**
 * "Chrome on macOS", "Safari on iPhone", "Firefox on Linux". Falls back to
 * "Browser" pieces rather than leaking the raw string. An installed iOS web
 * app reports itself as Safari, which is what it is.
 */
export function describeDevice(userAgent: string, maxTouchPoints = 0): string {
	const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'Browser';
	let system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
	// iPadOS asks for the desktop site and says "Macintosh".
	if (system === 'macOS' && maxTouchPoints > 1) system = 'iPad';
	return system ? `${browser} on ${system}` : browser;
}

/** base64url (VAPID public key) → the bytes `applicationServerKey` takes. */
export function applicationServerKeyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
	const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/**
 * Whether an existing browser subscription was made with `publicKey`. After an
 * operator rotates the VAPID pair, old subscriptions can no longer be pushed
 * to and must be replaced rather than re-registered.
 */
export function subscriptionMatchesKey(
	subscriptionKey: ArrayBuffer | null | undefined,
	publicKey: string
): boolean {
	if (!subscriptionKey) return true; // Browsers that do not expose it: assume it matches.
	const expected = applicationServerKeyBytes(publicKey);
	const actual = new Uint8Array(subscriptionKey);
	return (
		actual.length === expected.length && actual.every((byte, index) => byte === expected[index])
	);
}

/** i18n key for the line under the "Push notifications" heading. */
export function webPushStatusKey(state: {
	support: WebPushSupport;
	permission: NotificationPermission | 'unknown';
	isEnabledHere: boolean;
}): string {
	const prefix = 'components.preferences.webPush.status.';
	if (state.support === 'needs-home-screen') return `${prefix}needsHomeScreen`;
	if (state.support === 'unsupported') return `${prefix}unsupported`;
	if (state.permission === 'denied') return `${prefix}blocked`;
	return state.isEnabledHere ? `${prefix}on` : `${prefix}off`;
}
