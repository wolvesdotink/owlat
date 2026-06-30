/**
 * Provider credential validators — fire real requests so the setup flow never
 * silently accepts a typo'd API key.
 *
 * Single source of truth shared by the `owlat-setup` CLI wizard and the web
 * setup endpoint (`apps/web/server/api/setup/validate-provider.post.ts`), so
 * the two can never drift apart on which status codes mean "valid".
 */

export interface ValidationResult {
	ok: boolean;
	message: string;
}

export type SetupProvider = 'resend' | 'openai' | 'openrouter' | 'posthog' | 'safebrowsing';

const TIMEOUT_MS = 8_000;

/**
 * Block hosts that resolve to private, loopback, link-local, or cloud-metadata
 * addresses. `validatePostHogHost` fires a server-side request to a
 * caller-supplied host, so without this guard the setup endpoint is an SSRF
 * gadget for probing internal services (e.g. http://169.254.169.254/,
 * http://127.0.0.1:6379/). Hostname-literal check only — it stops the direct
 * IP-literal SSRF; DNS-rebinding to a public name is out of scope here, which is
 * why the endpoint should also remain behind the setup-token gate.
 */
function isBlockedSsrfHost(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
	if (
		h === 'localhost' ||
		h.endsWith('.localhost') ||
		h.endsWith('.local') ||
		h.endsWith('.internal')
	) {
		return true;
	}
	const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) {
		const o = v4.slice(1).map(Number);
		if (o.some((n) => n > 255)) return true; // malformed → block
		const [a, b] = o as [number, number, number, number];
		if (a === 0 || a === 127 || a === 10) return true;
		if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
		return false;
	}
	if (h.includes(':')) {
		// IPv6 literal
		if (h === '::1' || h === '::') return true;
		if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
		if (h.startsWith('::ffff:')) return true; // IPv4-mapped — conservatively block
		return false;
	}
	return false;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

export async function validateOpenAIKey(
	apiKey: string,
	baseUrl = 'https://api.openai.com/v1'
): Promise<ValidationResult> {
	try {
		const res = await fetchWithTimeout(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (res.status === 200) return { ok: true, message: 'OpenAI key accepted.' };
		if (res.status === 401) return { ok: false, message: 'OpenAI rejected the key (401 Unauthorized).' };
		return { ok: false, message: `OpenAI returned HTTP ${res.status}.` };
	} catch (e) {
		return { ok: false, message: `OpenAI request failed: ${(e as Error).message}` };
	}
}

export async function validateOpenRouterKey(apiKey: string): Promise<ValidationResult> {
	try {
		const res = await fetchWithTimeout('https://openrouter.ai/api/v1/models', {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (res.status === 200) return { ok: true, message: 'OpenRouter key accepted.' };
		if (res.status === 401) return { ok: false, message: 'OpenRouter rejected the key (401 Unauthorized).' };
		return { ok: false, message: `OpenRouter returned HTTP ${res.status}.` };
	} catch (e) {
		return { ok: false, message: `OpenRouter request failed: ${(e as Error).message}` };
	}
}

export async function validateResendKey(apiKey: string): Promise<ValidationResult> {
	try {
		const res = await fetchWithTimeout('https://api.resend.com/domains', {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (res.status === 200) return { ok: true, message: 'Resend key accepted.' };
		if (res.status === 401 || res.status === 403) {
			return { ok: false, message: 'Resend rejected the key.' };
		}
		return { ok: false, message: `Resend returned HTTP ${res.status}.` };
	} catch (e) {
		return { ok: false, message: `Resend request failed: ${(e as Error).message}` };
	}
}

export async function validatePostHogHost(host: string, apiKey?: string): Promise<ValidationResult> {
	let base: URL;
	try {
		base = new URL(host.startsWith('http') ? host : `https://${host}`);
	} catch {
		return { ok: false, message: 'PostHog host is not a valid URL.' };
	}
	if (base.protocol !== 'http:' && base.protocol !== 'https:') {
		return { ok: false, message: 'PostHog host must use http or https.' };
	}
	if (isBlockedSsrfHost(base.hostname)) {
		// Refuse private/loopback/link-local targets so this validator can't be
		// abused to probe internal services (SSRF).
		return { ok: false, message: 'PostHog host must be a public address.' };
	}
	try {
		const url = new URL('/decide', base);
		const res = await fetchWithTimeout(url.toString(), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token: apiKey ?? 'health-check', distinct_id: 'owlat-setup' }),
		});
		// PostHog returns 200 even on a bad token; we just verify the host is reachable.
		if (res.status < 500) return { ok: true, message: 'PostHog host reachable.' };
		return { ok: false, message: `PostHog host returned HTTP ${res.status}.` };
	} catch {
		// Do not echo the raw fetch error — it leaks a reachability/port-probe
		// oracle (ECONNREFUSED vs timeout vs DNS) to an unauthenticated caller.
		return { ok: false, message: 'PostHog host is not reachable.' };
	}
}

export async function validateGoogleSafeBrowsingKey(apiKey: string): Promise<ValidationResult> {
	try {
		const res = await fetchWithTimeout(
			`https://safebrowsing.googleapis.com/v4/threatLists?key=${encodeURIComponent(apiKey)}`,
			{}
		);
		if (res.status === 200) return { ok: true, message: 'Google Safe Browsing key accepted.' };
		if (res.status === 400 || res.status === 403) {
			return { ok: false, message: 'Google Safe Browsing rejected the key.' };
		}
		return { ok: false, message: `Google Safe Browsing returned HTTP ${res.status}.` };
	} catch (e) {
		return { ok: false, message: `Google Safe Browsing request failed: ${(e as Error).message}` };
	}
}

/** Dispatch to the right validator by provider name (used by the web endpoint). */
export async function validateProvider(
	provider: SetupProvider,
	apiKey: string,
	host?: string
): Promise<ValidationResult> {
	switch (provider) {
		case 'resend':
			return validateResendKey(apiKey);
		case 'openai':
			return validateOpenAIKey(apiKey);
		case 'openrouter':
			return validateOpenRouterKey(apiKey);
		case 'posthog':
			if (!host) return { ok: false, message: 'PostHog host is required.' };
			return validatePostHogHost(host, apiKey);
		case 'safebrowsing':
			return validateGoogleSafeBrowsingKey(apiKey);
		default:
			return { ok: false, message: `Unknown provider: ${provider as string}` };
	}
}
