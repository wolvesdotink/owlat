/**
 * Fact keys at rest (final review): a fact key (`factKeyString({entity,
 * attribute, context})`, e.g. a person's name and "diagnosis") is
 * model-derived text, so it is never stored in plaintext:
 *
 *   - `threadFacts.factKeyHash`: a keyed hash of the normalized key, what the
 *     planner matches on (`reducePlanFacts.ts`). HMAC-SHA256 under a subkey
 *     derived from INSTANCE_SECRET with its own label (domain separation from
 *     every other use of the secret), Web Crypto, so it runs in V8.
 *   - `threadFacts.factKeyLabel`: the key itself, sealed (`lib/messageBody.ts`),
 *     for the prompt and the UI.
 *
 * A redacted fact (`purgeClaims.ts`) has no label and the opaque hash
 * `redacted:<factId>`, which no HMAC equals. Rows written before this carry
 * the retired plaintext `factKey` (read for one release; migration 0068
 * converts them).
 *
 * Without INSTANCE_SECRET (an unprovisioned install, the test harness) the
 * subkey derives from a fixed placeholder: matching still works, and nothing
 * is sealed there anyway (`sealBodyAtWrite`).
 */

import type { Doc } from '../../_generated/dataModel';
import { getOptional } from '../../lib/env';
import { hmacSignature } from '../../lib/crypto';
import { openMessageBody, sealBodyAtWrite } from '../../lib/messageBody';

/** Domain-separation label of the fact-key subkey. */
const FACT_KEY_HASH_LABEL = 'owlat:thread-brief:fact-key-hash:v1';
/** Prefix of a redacted fact's opaque hash. */
const REDACTED_PREFIX = 'redacted:';

/** One key, as matching compares it. Pure. */
export function normalizeFactKey(key: string): string {
	return key.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

let subkey: { secret: string; key: Promise<string> } | null = null;

function factKeySubkey(): Promise<string> {
	const secret = getOptional('INSTANCE_SECRET') ?? '';
	if (subkey?.secret !== secret) {
		// An HMAC key may not be empty: an unprovisioned install uses a fixed one.
		const ikm = secret || 'owlat:unprovisioned';
		subkey = { secret, key: hmacSignature(ikm, FACT_KEY_HASH_LABEL, 'sha256', 'base64') };
	}
	return subkey.key;
}

/** The keyed hash a fact key is matched by. */
export async function factKeyHash(key: string): Promise<string> {
	return hmacSignature(await factKeySubkey(), normalizeFactKey(key), 'sha256', 'base64url');
}

/** Hashes of every key in `keys` (the incoming facts of one extraction). */
export async function factKeyHashes(keys: readonly string[]): Promise<Map<string, string>> {
	const hashes = new Map<string, string>();
	for (const key of keys) if (!hashes.has(key)) hashes.set(key, await factKeyHash(key));
	return hashes;
}

/** The opaque hash of a redacted fact. Pure. */
export function redactedFactKeyHash(factId: string): string {
	return `${REDACTED_PREFIX}${factId}`;
}

/** The stored key fields of a claim's key: hash and sealed label (the plaintext is retired). */
export async function storedFactKey(
	key: string
): Promise<Pick<Doc<'threadFacts'>, 'factKeyHash' | 'factKeyLabel'>> {
	return { factKeyHash: await factKeyHash(key), factKeyLabel: await sealBodyAtWrite(key) };
}

/** A row's hash: stored, or (a row from before) derived from its retired plaintext key. */
export async function rowFactKeyHash(
	row: Pick<Doc<'threadFacts'>, 'factKeyHash' | 'factKey'>
): Promise<string> {
	if (row.factKeyHash !== undefined) return row.factKeyHash;
	return factKeyHash(row.factKey ?? '');
}

/** A row's key as text (prompt, UI, export); empty for a redacted fact. */
export async function rowFactKeyLabel(
	row: Pick<Doc<'threadFacts'>, 'factKeyLabel' | 'factKey'>
): Promise<string> {
	if (row.factKeyLabel !== undefined) return openMessageBody(row.factKeyLabel);
	const legacy = row.factKey ?? '';
	return legacy.startsWith(REDACTED_PREFIX) ? '' : legacy;
}
