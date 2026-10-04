import type { NamedSecret } from './scanReportSecrets';

/**
 * The values a run mints or holds that the report scan has to search for on
 * top of the configured secrets (see scan-report-secrets.ts).
 *
 * The deployment URLs are repository secrets, but a report rarely carries one
 * whole: a WebSocket error names `wss://<host>/…`, a DNS error names the bare
 * host. So the host is searched for on its own as well.
 *
 * The session cookies exist only once the setup project has signed in, and it
 * saves them in its storage state file. That file is what every later spec
 * loads, so its cookies are exactly the ones a report could leak.
 */

/** Shorter values would match unrelated text, and no session credential is this short. */
const MIN_VALUE_LENGTH = 16;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `secrets`, plus the host of each one that is a URL. */
export function withUrlHosts(secrets: NamedSecret[]): NamedSecret[] {
	const result = [...secrets];
	for (const secret of secrets) {
		let url: URL;
		try {
			url = new URL(secret.value);
		} catch {
			continue;
		}
		if (!/^(https?|wss?):$/.test(url.protocol) || !url.hostname) continue;
		if (LOOPBACK.has(url.hostname)) continue;
		result.push({ label: `${secret.label} host`, value: url.hostname });
	}
	return result;
}

interface StorageState {
	cookies?: Array<{ name?: unknown; value?: unknown }>;
	origins?: Array<{ localStorage?: Array<{ name?: unknown; value?: unknown }> }>;
}

function add(secrets: NamedSecret[], label: string, value: string): void {
	if (value.length < MIN_VALUE_LENGTH) return;
	if (secrets.some((secret) => secret.value === value)) return;
	secrets.push({ label, value });
}

/**
 * Every cookie and localStorage value of a Playwright storage state that is
 * long enough to be a credential. A cookie counts as stored, URL-decoded, and
 * as the token before its signature (BetterAuth signs `token.signature`).
 *
 * Throws on a file that is not a storage state: the caller must not treat an
 * unreadable one as "no cookies".
 */
export function storageStateSecrets(json: string): NamedSecret[] {
	const state = JSON.parse(json) as StorageState;
	if (typeof state !== 'object' || state === null || !Array.isArray(state.cookies)) {
		throw new Error('not a Playwright storage state');
	}
	const secrets: NamedSecret[] = [];
	for (const cookie of state.cookies) {
		if (typeof cookie.value !== 'string') throw new Error('cookie without a string value');
		const label = `session cookie ${typeof cookie.name === 'string' ? cookie.name : '(unnamed)'}`;
		let decoded = cookie.value;
		try {
			decoded = decodeURIComponent(cookie.value);
		} catch {
			// Not URL-encoded; the stored value is all there is.
		}
		add(secrets, label, cookie.value);
		add(secrets, label, decoded);
		add(secrets, `${label} token`, decoded.split('.')[0] ?? '');
	}
	for (const origin of state.origins ?? []) {
		for (const item of origin.localStorage ?? []) {
			// Keys can hold a user id, so the label does not name them.
			if (typeof item.value !== 'string') continue;
			add(secrets, 'storage-state localStorage value', item.value);
		}
	}
	return secrets;
}
