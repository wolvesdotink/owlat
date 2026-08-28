/**
 * Which operating system the app is running on — spelled ONCE.
 *
 * It used to be spelled three times: `useDesktopContext` and
 * `plugins/0.desktop-workspace.client.ts` both tested the DEPRECATED
 * `navigator.platform`, `pages/desktop/settings.vue` tested `navigator.userAgent`
 * with a third set of patterns, and `usePostboxComposerKeys` had a fourth for the
 * ⌘ key. The three could disagree — `navigator.platform` on an Apple Silicon Mac
 * reports `MacIntel`, and Chromium freezes it entirely under user-agent reduction
 * — which meant the titlebar could style itself as Linux on the same machine
 * where the notification deep link pointed at macOS System Settings.
 *
 * `navigator.userAgentData.platform` is the supported replacement where it
 * exists (Chromium, which is what Tauri's webview is on Windows and Linux);
 * `navigator.userAgent` is the fallback everywhere else, including WKWebView on
 * macOS. Pure and parameterised, so the matrix unit-tests without a webview.
 */

/** The three targets we ship for. Anything unrecognised reads as Linux. */
export type DesktopPlatform = 'mac' | 'windows' | 'linux';

/** What a `navigator` contributes to the decision. Both halves are optional. */
export interface PlatformHints {
	/** `navigator.userAgentData?.platform` — "macOS", "Windows", "Linux". */
	readonly userAgentDataPlatform?: string | null | undefined;
	/** `navigator.userAgent`. */
	readonly userAgent?: string | null | undefined;
}

/**
 * Narrow the platform hints to one of the three targets.
 *
 * `userAgentData.platform` wins when present because it is the value the
 * browser still maintains. iPadOS and iOS answer `mac`: what the caller wants to
 * know is which modifier key and which OS conventions apply, and on every Apple
 * platform that answer is the same. Unknown is Linux — the branch that gives
 * instructions rather than a deep link that would fail silently. Pure.
 */
export function detectDesktopPlatform(hints: PlatformHints): DesktopPlatform {
	const declared = hints.userAgentDataPlatform?.trim();
	if (declared) {
		if (/mac|ios|iphone|ipad/i.test(declared)) return 'mac';
		if (/win/i.test(declared)) return 'windows';
		return 'linux';
	}
	const agent = hints.userAgent ?? '';
	if (/mac|iphone|ipad|ipod/i.test(agent)) return 'mac';
	if (/win/i.test(agent)) return 'windows';
	return 'linux';
}

/** The live platform, or `linux` when there is no `navigator` (SSR). */
export function readDesktopPlatform(): DesktopPlatform {
	if (typeof navigator === 'undefined') return 'linux';
	const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
	return detectDesktopPlatform({
		userAgentDataPlatform: data?.platform,
		userAgent: navigator.userAgent,
	});
}

/** The `<html>` class the native-chrome CSS keys off, per platform. */
export const PLATFORM_ROOT_CLASS: Readonly<Record<DesktopPlatform, string>> = Object.freeze({
	mac: 'is-mac',
	windows: 'is-win',
	linux: 'is-linux',
});
