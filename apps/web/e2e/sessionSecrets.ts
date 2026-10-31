import { isRecord } from '@owlat/shared/utils/guards';
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

function add(secrets: NamedSecret[], label: string, value: string): void {
	if (value.length < MIN_VALUE_LENGTH) return;
	if (secrets.some((secret) => secret.value === value)) return;
	secrets.push({ label, value });
}

/** `value` as a list of objects; throws, naming `what`, on anything else. */
function objectList(value: unknown, what: string): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error(`${what} is not a list`);
	return value.map((entry) => {
		if (!isRecord(entry)) throw new Error(`${what} holds an entry that is not an object`);
		return entry;
	});
}

/**
 * Every cookie and localStorage value of a Playwright storage state that is
 * long enough to be a credential. A cookie counts as stored, URL-decoded, and
 * as the token before its signature (BetterAuth signs `token.signature`).
 *
 * Throws on a file that is not a storage state, and on any part of one that
 * can hold a credential but cannot be read: the caller must not treat an
 * unreadable one as "no cookies". A localStorage value that is not a string
 * holds no credential text and is skipped.
 */
export function storageStateSecrets(json: string): NamedSecret[] {
	const state: unknown = JSON.parse(json);
	if (!isRecord(state) || !Array.isArray(state['cookies'])) {
		throw new Error('not a Playwright storage state');
	}
	const secrets: NamedSecret[] = [];
	for (const cookie of objectList(state['cookies'], 'cookies')) {
		const { name, value } = cookie;
		if (typeof value !== 'string') throw new Error('cookie without a string value');
		const label = `session cookie ${typeof name === 'string' ? name : '(unnamed)'}`;
		let decoded = value;
		try {
			decoded = decodeURIComponent(value);
		} catch {
			// Not URL-encoded; the stored value is all there is.
		}
		add(secrets, label, value);
		add(secrets, label, decoded);
		add(secrets, `${label} token`, decoded.split('.')[0] ?? '');
	}
	const origins = state['origins'] === undefined ? [] : objectList(state['origins'], 'origins');
	for (const origin of origins) {
		const items =
			origin['localStorage'] === undefined
				? []
				: objectList(origin['localStorage'], 'localStorage');
		for (const item of items) {
			// Keys can hold a user id, so the label does not name them.
			if (typeof item['value'] !== 'string') continue;
			add(secrets, 'storage-state localStorage value', item['value']);
		}
	}
	return secrets;
}
