/**
 * `_ostr.<domain>` key discovery (plan §5): the observer's signing key is
 * published in DNS as a DKIM-style tag list, so discovery and rotation ride on
 * DNS exactly as DKIM's do — no new PKI (plan §3).
 *
 *     _ostr.mx.example.com. IN TXT "v=1; k=ed25519; p=<base64 32-byte key>"
 *
 * Parsing is deliberately tolerant of formatting (whitespace anywhere, any tag
 * order, unknown tags ignored for forward compatibility) and strict about
 * meaning: an unusable record is an error, never a silently-skipped tag.
 *
 * A name may carry SEVERAL such records at once. That is how rotation works
 * without a flag day: publish the new key alongside the old, wait out the TTL
 * and the in-flight attestations, then withdraw the old one. Verifiers try
 * every published key ({@link selectVerifyingKey}).
 */
import type { Attestation } from '../types.js';
import { isEd25519Key, isFqdn } from './fields.js';
import { verifyAttestationSignature } from './sign.js';

export const OSTR_KEY_RECORD_PREFIX = '_ostr';

/** Practical ceiling; a real record is ~70 characters. */
const MAX_RECORD_LENGTH = 2048;

/**
 * `revoked` separates "this key is withdrawn, stop trusting it" (an empty `p`
 * tag, DKIM's convention) from "this record is corrupt, try the siblings".
 * Both are parse failures; only the first is a statement by the domain.
 */
export type OstrKeyRecordParse =
	| { ok: true; publicKeyBase64: string }
	| { ok: false; revoked: boolean; errors: string[] };

/**
 * The DNS owner name a domain's OSTR key is published at. Throws for anything
 * the rest of this module would not accept as an observer: `_ostr.Example.com.`
 * is a name no lookup here will ever match.
 */
export function ostrKeyRecordName(domain: string): string {
	if (!isFqdn(domain)) {
		throw new Error('domain must be a lowercase FQDN without a trailing dot');
	}
	return `${OSTR_KEY_RECORD_PREFIX}.${domain}`;
}

/**
 * Render the TXT record for a raw 32-byte base64 ed25519 public key. Throws on
 * anything else: publishing a malformed key silently disables verification for
 * every attestation the domain signs.
 */
export function formatOstrKeyRecord(publicKeyBase64: string): string {
	if (!isEd25519Key(publicKeyBase64)) {
		throw new Error('publicKeyBase64 must be a raw 32-byte ed25519 public key in base64');
	}
	return `v=1; k=ed25519; p=${publicKeyBase64}`;
}

interface TagList {
	tags: Map<string, string>;
	errors: string[];
}

function parseTagList(txt: string): TagList {
	const tags = new Map<string, string>();
	const errors: string[] = [];
	for (const segment of txt.split(';')) {
		if (segment.trim() === '') continue;
		const separator = segment.indexOf('=');
		if (separator < 0) {
			errors.push(`"${segment.trim()}" is not a tag=value pair`);
			continue;
		}
		const tag = segment.slice(0, separator).trim().toLowerCase();
		const value = segment.slice(separator + 1).trim();
		if (!/^[a-z][a-z0-9_]*$/.test(tag)) {
			errors.push(`"${tag}" is not a valid tag name`);
			continue;
		}
		if (tags.has(tag)) {
			errors.push(`tag ${tag} appears more than once`);
			continue;
		}
		tags.set(tag, value);
	}
	return { tags, errors };
}

/**
 * Parse one TXT record into the key it publishes.
 *
 * `v=1` is required. `k` defaults to `ed25519`, the only algorithm `v=1`
 * defines. `p` is required and must be a raw 32-byte key in CANONICAL base64;
 * DNS provisioning tools split long values, so whitespace inside it is
 * stripped, but a non-canonical spelling is rejected rather than re-encoded, so
 * one key has exactly one published form.
 */
export function parseOstrKeyRecord(txt: string): OstrKeyRecordParse {
	if (typeof txt !== 'string' || txt.trim() === '') {
		return { ok: false, revoked: false, errors: ['record must be a non-empty string'] };
	}
	if (txt.length > MAX_RECORD_LENGTH) {
		return {
			ok: false,
			revoked: false,
			errors: [`record must be at most ${MAX_RECORD_LENGTH} characters`],
		};
	}
	const { tags, errors } = parseTagList(txt);

	const version = tags.get('v');
	if (version === undefined) errors.push('missing v tag');
	else if (version !== '1') errors.push(`unsupported record version "${version}"`);

	const keyType = tags.get('k') ?? 'ed25519';
	if (keyType.toLowerCase() !== 'ed25519') {
		errors.push(`unsupported key type "${keyType}"`);
	}

	const rawKey = tags.get('p');
	let publicKeyBase64: string | undefined;
	let revoked = false;
	if (rawKey === undefined) {
		errors.push('missing p tag');
	} else {
		const packed = rawKey.replace(/\s+/g, '');
		if (packed === '') {
			// DKIM's revocation convention: the record exists, the key is withdrawn.
			revoked = true;
			errors.push('p tag is empty (revoked key)');
		} else if (!isEd25519Key(packed)) {
			errors.push('p tag must be a raw 32-byte ed25519 public key in base64');
		} else {
			publicKeyBase64 = packed;
		}
	}

	if (errors.length > 0 || publicKeyBase64 === undefined) {
		return { ok: false, revoked, errors: errors.length > 0 ? errors : ['missing p tag'] };
	}
	return { ok: true, publicKeyBase64 };
}

/**
 * The first published key that verifies `att`, or `null` if none does.
 *
 * Records that fail to parse are skipped, not fatal: during rotation a name
 * legitimately carries several records, and one broken sibling must not make
 * the good key unusable. Order follows the record list, so callers get a
 * deterministic answer for a deterministic DNS answer.
 */
export function selectVerifyingKey(records: readonly string[], att: Attestation): string | null {
	for (const record of records) {
		const parsed = parseOstrKeyRecord(record);
		if (!parsed.ok) continue;
		if (verifyAttestationSignature(att, parsed.publicKeyBase64)) return parsed.publicKeyBase64;
	}
	return null;
}
