/**
 * Automated-open classification.
 *
 * Not every fetch of the open pixel is a person reading the email. Apple Mail
 * Privacy Protection (MPP) fetches the pixel through Apple's proxy as soon as
 * the message lands, whether or not anyone reads it, and mail security gateways
 * and link scanners fetch images to inspect them. Counting those as opens
 * inflates every open rate.
 *
 * The classification runs in two steps so nothing personal is kept:
 *
 * 1. At request time (`trackingHttp.trackOpen`), `classifyOpenRequest` reduces
 *    the request's User-Agent and client IP to one coarse `OpenAgent` class.
 *    Only that class crosses into the database layer. The raw User-Agent and IP
 *    are never stored.
 * 2. In the Send lifecycle (`reduceOpened`), `automatedOpenReason` combines
 *    that class with the time since the send went out. The send row keeps a
 *    counter and a first-seen timestamp, not the signals.
 *
 * The rules are deliberately conservative. A browser or mail-client
 * User-Agent from a non-Apple address counts as a person, and so do the
 * Gmail and Yahoo image proxies: those fetch when the reader opens the message.
 */

import { v, type Infer } from 'convex/values';

/**
 * The coarse class of the client that fetched the pixel. The validator is the
 * single source; the `opened` transition argument reuses it.
 */
export const openAgentValidator = v.union(
	v.literal('apple_proxy'),
	v.literal('scanner'),
	v.literal('client')
);
export type OpenAgent = Infer<typeof openAgentValidator>;

/** Why an open was judged automated. */
export type AutomatedOpenReason = 'apple_mpp' | 'scanner' | 'prefetch';

/**
 * An open (or click, see `automatedClicks.ts`) this soon after the send was
 * handed off is a gateway fetching the message on arrival, not a reader. Five seconds is short enough that no
 * person could have received, noticed and opened the email in that window.
 */
export const PREFETCH_WINDOW_MS = 5_000;

/**
 * The User-Agent Apple's MPP proxy sends: exactly `Mozilla/5.0`, with none of
 * the platform or engine tokens a real browser or mail client adds.
 */
export const APPLE_PROXY_USER_AGENT = 'mozilla/5.0';

/**
 * A bot's self-identifying token: `bot` as a word of its own, or a name ending
 * in `bot` followed by a version or suffix (`googlebot/2.1`, `Slackbot-LinkExpanding`).
 * A bare substring match would also catch device names that merely contain the
 * letters, such as the Android model token `CUBOT X50`, and drop real opens.
 */
const BOT_USER_AGENT_TOKEN = /(^|[^a-z])bot([^a-z]|$)|bot[/-]/;

/**
 * User-Agent fragments of security gateways, link scanners, previewers and
 * HTTP libraries. Matched case-insensitively as substrings.
 */
const SCANNER_USER_AGENT_FRAGMENTS: readonly string[] = [
	'crawler',
	'spider',
	'scanner',
	'bingpreview',
	'barracuda',
	'mimecast',
	'proofpoint',
	'messagelabs',
	'symantec',
	'trendmicro',
	'trend micro',
	'sophos',
	'forcepoint',
	'fortinet',
	'fortiguard',
	'ironport',
	'zscaler',
	'headlesschrome',
	'phantomjs',
	'curl/',
	'wget/',
	'python-requests',
	'python-urllib',
	'aiohttp',
	'go-http-client',
	'java/',
	'okhttp',
	'node-fetch',
	'axios/',
	'libwww-perl',
	'apache-httpclient',
	'scrapy',
];

/**
 * Apple's own networks. MPP fetches come from Apple-operated addresses, and
 * Apple holds all of 17.0.0.0/8 for IPv4. The two IPv6 prefixes are Apple's
 * registered allocations (2620:149::/32 in ARIN, 2a01:b740::/32 in RIPE).
 */
const APPLE_IPV6_PREFIXES: readonly (readonly [number, number])[] = [
	[0x2620, 0x0149],
	[0x2a01, 0xb740],
];

function isAppleIpv4(ip: string): boolean {
	const octets = ip.split('.');
	if (octets.length !== 4) return false;
	if (!octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return false;
	return Number(octets[0]) === 17;
}

function isAppleIpv6(ip: string): boolean {
	const hextets = ip.toLowerCase().split(':');
	if (hextets.length < 3 || hextets[0] === '' || hextets[1] === '') return false;
	const first = Number.parseInt(hextets[0]!, 16);
	const second = Number.parseInt(hextets[1]!, 16);
	return APPLE_IPV6_PREFIXES.some(([a, b]) => first === a && second === b);
}

/**
 * Whether a client IP sits in one of Apple's networks. Accepts IPv4, IPv6 and
 * IPv4-mapped IPv6 (`::ffff:17.1.2.3`). Anything unparseable, including the
 * `unknown` that `getClientIp` returns without a trusted proxy, is not Apple.
 */
export function isAppleNetworkIp(ip: string | null | undefined): boolean {
	if (!ip) return false;
	const trimmed = ip.trim();
	if (trimmed.includes('.')) {
		const lastColon = trimmed.lastIndexOf(':');
		return isAppleIpv4(lastColon === -1 ? trimmed : trimmed.slice(lastColon + 1));
	}
	return trimmed.includes(':') && isAppleIpv6(trimmed);
}

/**
 * Reduce a pixel request to its coarse client class. A missing User-Agent is a
 * scanner: every mail client and image proxy sends one.
 */
export function classifyOpenRequest(request: {
	userAgent: string | null | undefined;
	clientIp: string | null | undefined;
}): OpenAgent {
	const userAgent = (request.userAgent ?? '').trim().toLowerCase();
	if (userAgent === APPLE_PROXY_USER_AGENT || isAppleNetworkIp(request.clientIp)) {
		return 'apple_proxy';
	}
	return isScannerUserAgent(userAgent) ? 'scanner' : 'client';
}

/**
 * Whether a lowercased, trimmed User-Agent belongs to a bot, security gateway,
 * link scanner or HTTP library. A missing User-Agent counts: every mail client,
 * browser and image proxy sends one. Shared with click classification
 * (`automatedClicks.ts`).
 */
export function isScannerUserAgent(userAgent: string): boolean {
	return (
		userAgent === '' ||
		BOT_USER_AGENT_TOKEN.test(userAgent) ||
		SCANNER_USER_AGENT_FRAGMENTS.some((fragment) => userAgent.includes(fragment))
	);
}

/**
 * Decide whether one open is automated, and why. `agent` is absent for opens
 * reported by a provider webhook rather than our own pixel; those carry no
 * request to judge and keep counting as opens, as they always have.
 */
export function automatedOpenReason(open: {
	agent: OpenAgent | undefined;
	at: number;
	sentAt: number | undefined;
}): AutomatedOpenReason | null {
	if (open.agent === undefined) return null;
	if (open.agent === 'apple_proxy') return 'apple_mpp';
	if (open.agent === 'scanner') return 'scanner';
	if (open.sentAt === undefined) return null;
	const sinceSent = open.at - open.sentAt;
	return sinceSent >= 0 && sinceSent < PREFETCH_WINDOW_MS ? 'prefetch' : null;
}
