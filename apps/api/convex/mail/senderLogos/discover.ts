'use node';

/**
 * Finding a sender domain's logo: its BIMI logo when the domain enforces
 * DMARC and publishes one, else the icon its own website declares.
 *
 * Runs only server-side, from the delivery-triggered action in `fetch.ts`,
 * so no reader's client ever contacts the sender (a client-side fetch would
 * tell the sender when the mail was read). Every request goes through the
 * SSRF guard, is HTTPS only, follows a few redirects at most (each one checked
 * again), has a timeout, and reads a capped body. A homepage that redirects to
 * another organisation is not the sender's site, so its icon is not used.
 *
 * The VMC a BIMI record may point at is not validated, so a BIMI logo is
 * treated like a site icon: the domain's own claim, shown because the message
 * passed DMARC for that domain, never as a verified trademark.
 */

import { promises as dns } from 'dns';
import { readStreamPrefix } from '@owlat/shared';
import { organizationalDomain } from '@owlat/shared/dnsZone';
import { fetchGuarded } from '../../lib/ssrfGuard';
import { extractWebsiteSignals } from '../../workspaces/brandKitWebsite';
import {
	acceptedLogoType,
	bimiLogoUrl,
	isDmarcEnforcing,
	mediaTypeOf,
	MAX_BIMI_LOGO_BYTES,
	MAX_ICON_BYTES,
	type SenderLogoMimeType,
} from './logoRecords';

const FETCH_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 2;
const MAX_PAGE_BYTES = 256 * 1024;
/** Icons tried per domain, the declared ones first, `/favicon.ico` last. */
const MAX_ICON_ATTEMPTS = 3;
const USER_AGENT = 'Owlat sender logo';

export interface FoundLogo {
	source: 'bimi' | 'icon';
	mimeType: SenderLogoMimeType;
	bytes: Uint8Array<ArrayBuffer>;
}

/** DNS and HTTP, injectable so the discovery runs in tests without a network. */
export interface SenderLogoDeps {
	resolveTxt(name: string): Promise<string[][]>;
	/** A guarded GET; the default is `fetchGuarded`. */
	fetch(url: string, init: RequestInit & { maxRedirects: number }): Promise<Response>;
}

const defaultDeps: SenderLogoDeps = {
	resolveTxt: (name) => dns.resolveTxt(name),
	fetch: (url, init) => fetchGuarded(url, { ...init, protocols: ['https:'] }),
};

/** TXT records of `name` as joined strings; none on any DNS error. */
async function txtRecords(deps: SenderLogoDeps, name: string): Promise<string[]> {
	try {
		return (await deps.resolveTxt(name)).map((chunks) => chunks.join(''));
	} catch {
		return [];
	}
}

/** GET `url`; `null` on a refusal, a network error or a non-2xx answer. */
async function get(deps: SenderLogoDeps, url: string, accept: string): Promise<Response | null> {
	let response: Response;
	try {
		response = await deps.fetch(url, {
			headers: { accept, 'user-agent': USER_AGENT },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			maxRedirects: MAX_REDIRECTS,
		});
	} catch {
		return null;
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		return null;
	}
	return response;
}

/** The whole body when it fits `maxBytes`, else `null`. */
async function readAll(
	response: Response,
	maxBytes: number
): Promise<Uint8Array<ArrayBuffer> | null> {
	try {
		const prefix = await readStreamPrefix(response.body, maxBytes, {
			timeoutMs: FETCH_TIMEOUT_MS,
		});
		return prefix && !prefix.truncated ? prefix.bytes : null;
	} catch {
		return null;
	}
}

async function fetchImage(
	deps: SenderLogoDeps,
	url: string,
	opts: { maxBytes: number; svgOnly: boolean }
): Promise<{ mimeType: SenderLogoMimeType; bytes: Uint8Array<ArrayBuffer> } | null> {
	const accept = opts.svgOnly ? 'image/svg+xml' : 'image/svg+xml,image/png,image/x-icon,image/*';
	const response = await get(deps, url, accept);
	if (!response) return null;
	const declared = mediaTypeOf(response.headers.get('content-type'));
	const bytes = await readAll(response, opts.maxBytes);
	if (!bytes) return null;
	const mimeType = acceptedLogoType(declared, bytes, { svgOnly: opts.svgOnly });
	return mimeType ? { mimeType, bytes } : null;
}

async function bimiLogo(deps: SenderLogoDeps, domain: string): Promise<FoundLogo | null> {
	if (!isDmarcEnforcing(await txtRecords(deps, `_dmarc.${domain}`))) return null;
	const url = bimiLogoUrl(await txtRecords(deps, `default._bimi.${domain}`));
	if (!url) return null;
	const image = await fetchImage(deps, url, { maxBytes: MAX_BIMI_LOGO_BYTES, svgOnly: true });
	return image ? { source: 'bimi', ...image } : null;
}

/** The icon URLs the domain's homepage declares, best first. */
async function declaredIcons(deps: SenderLogoDeps, domain: string): Promise<string[]> {
	const page = await get(deps, `https://${domain}/`, 'text/html');
	if (!page) return [];
	const pageUrl = page.url || `https://${domain}/`;
	const isHtml = /text\/html|application\/xhtml/.test(
		mediaTypeOf(page.headers.get('content-type'))
	);
	let host: string | null = null;
	try {
		host = new URL(pageUrl).hostname;
	} catch {
		// an unparseable final URL is not the sender's site
	}
	if (!isHtml || host === null || organizationalDomain(host) !== domain) {
		await page.body?.cancel().catch(() => undefined);
		return [];
	}
	const prefix = await readStreamPrefix(page.body, MAX_PAGE_BYTES, {
		timeoutMs: FETCH_TIMEOUT_MS,
	}).catch(() => null);
	if (!prefix) return [];
	const html = new TextDecoder('utf-8').decode(prefix.bytes);
	return extractWebsiteSignals(html, pageUrl)
		.logoCandidates.filter((c) => c.source === 'appleTouchIcon' || c.source === 'icon')
		.map((c) => c.url)
		.filter((url) => url.startsWith('https://'));
}

async function siteIcon(deps: SenderLogoDeps, domain: string): Promise<FoundLogo | null> {
	const candidates = [...(await declaredIcons(deps, domain)), `https://${domain}/favicon.ico`];
	for (const url of [...new Set(candidates)].slice(0, MAX_ICON_ATTEMPTS)) {
		const image = await fetchImage(deps, url, { maxBytes: MAX_ICON_BYTES, svgOnly: false });
		if (image) return { source: 'icon', ...image };
	}
	return null;
}

/** The logo `domain` publishes, or `null` when it publishes nothing usable. */
export async function discoverSenderLogo(
	domain: string,
	deps: SenderLogoDeps = defaultDeps
): Promise<FoundLogo | null> {
	return (await bimiLogo(deps, domain)) ?? (await siteIcon(deps, domain));
}
