/**
 * `DKIM_KEYS`: the DKIM keys seeded into Redis at boot, as JSON
 * (`{"example.com":{"selector":"s1","privateKey":"..."}}`).
 *
 * Split out of `config.ts` to keep that module under the file-size gate. A
 * value of the wrong shape fails startup here rather than at the first
 * signature: a key without a selector or private key would otherwise be seeded
 * and break DKIM for that domain. Errors name the domain, never the key text.
 */

import { isRecord } from '@owlat/shared/utils/guards';
import type { DkimKeyConfig } from './types.js';

const FORMAT = '{"domain.com":{"selector":"s1","privateKey":"..."}}';

function decodeDkimKey(domain: string, value: unknown): DkimKeyConfig {
	if (isRecord(value)) {
		const { selector, privateKey, organizationId } = value;
		if (
			typeof selector === 'string' &&
			typeof privateKey === 'string' &&
			(organizationId === undefined || typeof organizationId === 'string')
		) {
			return {
				selector,
				privateKey,
				...(organizationId === undefined ? {} : { organizationId }),
			};
		}
	}
	throw new Error(
		`DKIM_KEYS[${JSON.stringify(domain)}] must be {"selector":"...","privateKey":"..."} with an optional string organizationId`
	);
}

/** The keys `raw` declares; none when it is unset or empty. */
export function parseDkimKeys(raw: string | undefined): Record<string, DkimKeyConfig> {
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`DKIM_KEYS must be valid JSON: ${FORMAT}`);
	}
	if (!isRecord(parsed)) {
		throw new Error(`DKIM_KEYS must be a JSON object keyed by domain: ${FORMAT}`);
	}
	const keys: Record<string, DkimKeyConfig> = {};
	for (const [domain, value] of Object.entries(parsed)) {
		keys[domain] = decodeDkimKey(domain, value);
	}
	return keys;
}
