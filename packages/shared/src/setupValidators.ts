/**
 * Provider credential validators — fire real requests so the setup flow never
 * silently accepts a typo'd API key.
 *
 * Single source of truth shared by the `owlat-setup` CLI wizard and the web
 * setup endpoint (`apps/web/server/api/setup/validate-provider.post.ts`), so
 * the two can never drift apart on which status codes mean "valid".
 *
 * API-key providers are checked with `fetch` here; the generic SMTP relay is
 * checked with a real SMTP handshake + AUTH exchange in
 * `./setupSmtpRelayValidator`, re-exported below so this module stays the one
 * import path callers use. Host targets supplied by the caller go through the
 * SSRF guard in `./setupSsrfGuard`. Every entry point is only ever imported
 * server-side (the Nitro setup endpoint and the CLI) — never bundled into the
 * browser — so the Node built-ins those siblings reach for are safe.
 */

import { validateEmailitKey } from './emailitSetupValidator';
import { fetchSetupProvider, type ValidationResult } from './setupValidationHttp';
import { isBlockedSsrfHost, resolvesToBlockedAddress } from './setupSsrfGuard';

export type { ValidationResult } from './setupValidationHttp';
export { validateEmailitKey } from './emailitSetupValidator';
export { validateSmtpRelay, type SmtpRelayInput } from './setupSmtpRelayValidator';

export type SetupProvider =
	| 'resend'
	| 'emailit'
	| 'openai'
	| 'openrouter'
	| 'posthog'
	| 'safebrowsing';

export async function validateOpenAIKey(
	apiKey: string,
	baseUrl = 'https://api.openai.com/v1'
): Promise<ValidationResult> {
	try {
		const res = await fetchSetupProvider(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (res.status === 200) return { ok: true, message: 'OpenAI key accepted.' };
		if (res.status === 401)
			return { ok: false, message: 'OpenAI rejected the key (401 Unauthorized).' };
		return { ok: false, message: `OpenAI returned HTTP ${res.status}.` };
	} catch (e) {
		return { ok: false, message: `OpenAI request failed: ${(e as Error).message}` };
	}
}

export async function validateOpenRouterKey(apiKey: string): Promise<ValidationResult> {
	try {
		const res = await fetchSetupProvider('https://openrouter.ai/api/v1/models', {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (res.status === 200) return { ok: true, message: 'OpenRouter key accepted.' };
		if (res.status === 401)
			return { ok: false, message: 'OpenRouter rejected the key (401 Unauthorized).' };
		return { ok: false, message: `OpenRouter returned HTTP ${res.status}.` };
	} catch (e) {
		return { ok: false, message: `OpenRouter request failed: ${(e as Error).message}` };
	}
}

export async function validateResendKey(apiKey: string): Promise<ValidationResult> {
	try {
		const res = await fetchSetupProvider('https://api.resend.com/domains', {
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

export async function validatePostHogHost(
	host: string,
	apiKey?: string
): Promise<ValidationResult> {
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
	if (await resolvesToBlockedAddress(base.hostname)) {
		// A public name that resolves to an internal address (public-name → internal-IP).
		return { ok: false, message: 'PostHog host must be a public address.' };
	}
	try {
		const url = new URL('/decide', base);
		const res = await fetchSetupProvider(url.toString(), {
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
		const res = await fetchSetupProvider(
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
		case 'emailit':
			return validateEmailitKey(apiKey);
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
