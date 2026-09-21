/**
 * Active-session rows for the sign-in and security page (plan idea 57).
 *
 * BetterAuth's `session` table has carried `ipAddress` and `userAgent` since the
 * schema was written; nothing has ever read them. The list endpoint returns raw
 * rows — a token, two timestamps and a user-agent string — and a person looking
 * at that list is asking one question: *is one of these not me?* Answering it
 * needs a device name, a place to compare, and a "when", in that order.
 *
 * Everything here is PURE and module scope: no `useI18n`, no auth client, no
 * clock of its own (the caller passes `now`). Device names and the empty-state
 * copy come out as `{ key, params }` descriptors that the page resolves at the
 * render boundary, so a locale change re-renders without recomputing anything.
 *
 * The user-agent registry is deliberately small. A full UA-parsing dependency
 * buys precision nobody needs here — "Chrome on macOS" is the whole ask, and a
 * string this module cannot place says so ("Unrecognised device") rather than
 * guessing, because a wrong device name on a security screen is worse than no
 * device name at all.
 */

import type { LocalizedText } from '~/utils/readinessGate';

/** A session row as BetterAuth's `/list-sessions` returns it (JSON: dates are strings). */
export type AuthSessionRecord = {
	id: string;
	token: string;
	createdAt: string | number | Date;
	updatedAt: string | number | Date;
	expiresAt: string | number | Date;
	ipAddress?: string | null;
	userAgent?: string | null;
};

/**
 * What kind of thing the session is on. Drives the icon only — the readable
 * name is the browser/platform pair.
 */
export type SessionDeviceKind = 'desktop-app' | 'phone' | 'tablet' | 'computer' | 'unknown';

export type SessionDevice = {
	kind: SessionDeviceKind;
	/** Lucide icon name, so the page never maps kind → icon a second time. */
	icon: string;
	browser: LocalizedText;
	platform: LocalizedText;
};

export type ActiveSessionRow = SessionDevice & {
	id: string;
	/** The revoke handle. `/revoke-session` takes the token, not the id. */
	token: string;
	isCurrent: boolean;
	ipAddress: string | null;
	/** Epoch ms. `updatedAt` is refreshed on every session read, so it IS "last seen". */
	lastSeenAt: number;
	createdAt: number;
	expiresAt: number;
};

const KEY = 'dashboard.preferences.security.device';

/**
 * Ordered browser matchers — FIRST MATCH WINS, and the order is the whole
 * correctness argument: every Chromium browser still ships `Chrome` in its UA,
 * and Chrome itself still ships `Safari`. Edge before Chrome before Safari, or
 * every Edge session is labelled Chrome and every Chrome session is Safari.
 */
const BROWSERS: ReadonlyArray<{
	match: RegExp;
	text: LocalizedText;
	/**
	 * Set only by the packaged app: it overrides the platform's kind, because
	 * "installed app" is the distinction a person scanning this list cares
	 * about, not which OS the app happens to run on.
	 */
	overridesKind?: SessionDeviceKind;
}> = [
	// The packaged desktop app is a system webview, so it is named by the app it
	// is, not by the engine underneath.
	{
		match: /Tauri|Owlat/i,
		text: { key: `${KEY}.browsers.owlatDesktop` },
		overridesKind: 'desktop-app',
	},
	{ match: /Edg[A-Z]?\//, text: { key: `${KEY}.browsers.edge` } },
	{ match: /OPR\/|Opera/, text: { key: `${KEY}.browsers.opera` } },
	{ match: /Firefox\/|FxiOS\//, text: { key: `${KEY}.browsers.firefox` } },
	{ match: /Chrome\/|CriOS\//, text: { key: `${KEY}.browsers.chrome` } },
	{ match: /Safari\//, text: { key: `${KEY}.browsers.safari` } },
];

/**
 * Ordered platform matchers. iPadOS 13+ reports a desktop Macintosh UA, so the
 * iPad probe has to come first and lean on the touch hint Safari still sends.
 */
const PLATFORMS: ReadonlyArray<{
	match: RegExp;
	text: LocalizedText;
	kind: SessionDeviceKind;
}> = [
	{ match: /iPhone|iPod/, text: { key: `${KEY}.platforms.ios` }, kind: 'phone' },
	{ match: /iPad/, text: { key: `${KEY}.platforms.ipados` }, kind: 'tablet' },
	{ match: /Android.*Mobile/, text: { key: `${KEY}.platforms.android` }, kind: 'phone' },
	{ match: /Android/, text: { key: `${KEY}.platforms.android` }, kind: 'tablet' },
	{ match: /CrOS/, text: { key: `${KEY}.platforms.chromeOs` }, kind: 'computer' },
	{ match: /Macintosh|Mac OS X/, text: { key: `${KEY}.platforms.macos` }, kind: 'computer' },
	{ match: /Windows/, text: { key: `${KEY}.platforms.windows` }, kind: 'computer' },
	{ match: /Linux|X11/, text: { key: `${KEY}.platforms.linux` }, kind: 'computer' },
];

const UNKNOWN_DEVICE: SessionDevice = {
	kind: 'unknown',
	icon: 'lucide:globe',
	browser: { key: `${KEY}.browsers.unknown` },
	platform: { key: `${KEY}.platforms.unknown` },
};

const ICONS: Record<SessionDeviceKind, string> = {
	'desktop-app': 'lucide:app-window',
	phone: 'lucide:smartphone',
	tablet: 'lucide:tablet',
	computer: 'lucide:monitor',
	unknown: 'lucide:globe',
};

/**
 * Name the device behind a user-agent string.
 *
 * An absent or unplaceable UA yields the `unknown` device rather than a
 * half-filled one: "Firefox on an unrecognised system" reads like a bug, while
 * a row that admits it cannot name the device still lets its IP and last-seen
 * do their job.
 */
export function describeUserAgent(userAgent: string | null | undefined): SessionDevice {
	const ua = (userAgent ?? '').trim();
	if (!ua) return UNKNOWN_DEVICE;

	const browser = BROWSERS.find((entry) => entry.match.test(ua));
	const platform = PLATFORMS.find((entry) => entry.match.test(ua));
	if (!browser && !platform) return UNKNOWN_DEVICE;

	const kind: SessionDeviceKind = browser?.overridesKind ?? platform?.kind ?? 'unknown';

	return {
		kind,
		icon: ICONS[kind],
		browser: browser?.text ?? UNKNOWN_DEVICE.browser,
		platform: platform?.text ?? UNKNOWN_DEVICE.platform,
	};
}

/** Dates cross the wire as ISO strings; the component gets epoch ms or nothing. */
function toMillis(value: string | number | Date | null | undefined): number {
	if (value == null) return 0;
	const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isFinite(parsed) ? parsed : 0;
}

/** An IP the server never recorded is `null`, not the empty string. */
function normalizeIp(value: string | null | undefined): string | null {
	const trimmed = (value ?? '').trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalise and order the session list.
 *
 * The current session is pinned first and can never be revoked from the list —
 * revoking it is "sign out", which is a different button with different copy.
 * The rest sort by last seen, newest first, so an unfamiliar session that is
 * ACTIVE right now surfaces at the top where it is noticed.
 */
export function toActiveSessionRows(
	sessions: readonly AuthSessionRecord[],
	options: { currentToken?: string | null } = {}
): ActiveSessionRow[] {
	const currentToken = options.currentToken ?? null;

	return sessions
		.map((session) => ({
			...describeUserAgent(session.userAgent),
			id: session.id,
			token: session.token,
			isCurrent: currentToken != null && session.token === currentToken,
			ipAddress: normalizeIp(session.ipAddress),
			lastSeenAt: toMillis(session.updatedAt) || toMillis(session.createdAt),
			createdAt: toMillis(session.createdAt),
			expiresAt: toMillis(session.expiresAt),
		}))
		.sort((a, b) => {
			if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
			if (a.lastSeenAt !== b.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
			return a.id.localeCompare(b.id);
		});
}

/** How many sessions "sign out everywhere else" would actually end. */
export function countOtherSessions(rows: readonly ActiveSessionRow[]): number {
	return rows.filter((row) => !row.isCurrent).length;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "When was this last used", as a descriptor.
 *
 * Deliberately NOT `utils/formatters.ts`: every relative helper there returns
 * hardcoded English ("3 hours ago"), which is precisely what this page must not
 * paint. Past 7 days the caller renders the absolute date instead, so the
 * descriptor says so with `exact: null` rather than inventing a "5 weeks" bucket
 * nobody reads off a security screen.
 */
export function describeLastSeen(lastSeenAt: number, now: number): LocalizedText | null {
	const elapsed = now - lastSeenAt;
	if (!Number.isFinite(elapsed) || lastSeenAt <= 0) return null;
	// A clock skew between server and browser must not read as "in 3 minutes".
	if (elapsed < MINUTE) return { key: `${KEY}.lastSeen.now` };
	if (elapsed < HOUR) {
		return { key: `${KEY}.lastSeen.minutes`, params: { count: Math.floor(elapsed / MINUTE) } };
	}
	if (elapsed < DAY) {
		return { key: `${KEY}.lastSeen.hours`, params: { count: Math.floor(elapsed / HOUR) } };
	}
	if (elapsed < 7 * DAY) {
		return { key: `${KEY}.lastSeen.days`, params: { count: Math.floor(elapsed / DAY) } };
	}
	return null;
}
