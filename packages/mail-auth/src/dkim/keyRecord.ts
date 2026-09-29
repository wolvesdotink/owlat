/**
 * RFC 6376 §3.6.1 DKIM public-key (`_domainkey` TXT) record parsing and key
 * resolution.
 *
 * The input is untrusted DNS data, so this module is HOSTILE-INPUT SAFE: it
 * never throws. Every malformed record — an empty / revoked `p=`, a
 * `v=` mismatch, an unknown key type, joined TXT strings, or outright garbage —
 * resolves to a structured outcome the verifier can act on, never an
 * exception. (Locked decision D7: the verifier as a whole never throws.)
 *
 * {@link resolveDkimKey} is the ONE place the `_domainkey` key-record policy
 * lives (lookup, revocation, key type, `h=`, `s=`, the RFC 8301 RSA floor). The
 * DKIM verifier (`./messageSignature.ts`) and the ARC-Seal verifier
 * (`../arc/seal.ts`) both call it and differ only in how they map a failure
 * reason: DKIM to a verdict, ARC to a thrown error.
 */

import { createPublicKey, type KeyObject } from 'crypto';
import { isNoRecordDnsError } from '../dnsErrors.js';
import { parseTagList, stripWsp } from './tagList.js';

/**
 * The DNS surface the verifiers need: a TXT lookup returning the raw
 * character-strings of each record. Shape-compatible with `mailauth`'s
 * resolver and with the mocked resolvers the existing inbound tests use, so a
 * single resolver drives both sides of the differential suite.
 */
export type DkimDnsResolver = (name: string, rrtype: 'TXT') => Promise<string[][]>;

/** DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * RFC 8301 §3.2: verifiers MUST NOT treat an RSA public key shorter than 1024
 * bits as valid. Below this a signature is trivially forgeable (a sub-1024-bit
 * modulus is factorable), so a "valid" signature from such a key must never
 * authenticate a message. mailauth (the differential oracle) enforces the same
 * `minBitLength: 1024` with a policy/weak-key result — never `pass`.
 */
const MIN_RSA_KEY_BITS = 1024;

/** A successfully-parsed DKIM key record. */
export interface DkimKeyRecord {
	/** `v=` — version. Absent is tolerated; when present it must be `DKIM1`. */
	readonly version?: string;
	/** `k=` — key type. Defaults to `rsa` per §3.6.1. */
	readonly keyType: 'rsa' | 'ed25519';
	/** `h=` — acceptable hash algorithms, if the record restricts them. */
	readonly hashAlgorithms?: readonly string[];
	/** `p=` — base64 public key material (empty string means revoked). */
	readonly publicKey: string;
	/** `t=` — flags (`y` testing, `s` no-subdomain, …). */
	readonly flags: readonly string[];
	/** `s=` — service types (`*` or `email`). */
	readonly serviceTypes: readonly string[];
	/** Convenience: `t=y` is set. */
	readonly testing: boolean;
	/** Convenience: `p=` is present but empty — the key has been revoked. */
	readonly revoked: boolean;
}

/** A record we could not use. `reason` distinguishes the failure classes. */
export interface DkimKeyRecordError {
	readonly error: true;
	/**
	 * `syntax`   — the record is not a parseable tag list / wrong version.
	 * `unsupported` — a syntactically-valid record with a key type we can't verify.
	 */
	readonly reason: 'syntax' | 'unsupported';
	readonly message: string;
}

export type ParsedKeyRecord = DkimKeyRecord | DkimKeyRecordError;

/** Type guard: did `parseDkimKeyRecord` fail? */
export function isKeyRecordError(record: ParsedKeyRecord): record is DkimKeyRecordError {
	return 'error' in record;
}

/**
 * Parse one joined DKIM key TXT record. `txt` is the concatenation of the
 * record's character-strings (RFC 1035 §3.3.14) — the caller joins multi-chunk
 * TXT records before calling. Tag names are lowercased for lookup; values keep
 * their case but have all internal whitespace removed, since base64 (`p=`,
 * folded across TXT chunks) and colon lists (`h=`, `t=`) never contain WSP.
 */
export function parseDkimKeyRecord(txt: string): ParsedKeyRecord {
	const tags = parseTagList(txt, {
		lowercaseName: true,
		normalizeValue: stripWsp,
	});

	// v= is optional, but if present it MUST be DKIM1 (§3.6.1).
	const version = tags.get('v');
	if (version !== undefined && version !== '' && version !== 'DKIM1') {
		return { error: true, reason: 'syntax', message: `unsupported key version: ${version}` };
	}

	const keyTypeRaw = tags.get('k') ?? 'rsa';
	if (keyTypeRaw !== 'rsa' && keyTypeRaw !== 'ed25519') {
		return { error: true, reason: 'unsupported', message: `unsupported key type: ${keyTypeRaw}` };
	}

	// p= MUST be present. Absent tag => malformed; present-but-empty => revoked.
	const publicKey = tags.get('p');
	if (publicKey === undefined) {
		return { error: true, reason: 'syntax', message: 'missing p= tag' };
	}

	const flags = splitList(tags.get('t'));
	const serviceTypes = splitList(tags.get('s'));
	const hashTag = tags.get('h');
	const hashAlgorithms = hashTag !== undefined && hashTag !== '' ? splitList(hashTag) : undefined;

	return {
		version,
		keyType: keyTypeRaw,
		hashAlgorithms,
		publicKey,
		flags,
		serviceTypes,
		testing: flags.includes('y'),
		revoked: publicKey === '',
	};
}

/** Split a colon-separated tag list (`h=`, `t=`, `s=`) into lowercase items. */
function splitList(value: string | undefined): string[] {
	if (value === undefined || value === '') {
		return [];
	}
	return value
		.split(':')
		.map((item) => item.trim().toLowerCase())
		.filter((item) => item !== '');
}

/** Why {@link resolveDkimKey} could not produce a usable key before a record was chosen. */
type DkimKeyLookupFailure = 'no-record' | 'dns-temp' | 'dns-perm' | 'unparseable';

/** Why a parsed key record is unusable for the requested algorithm. */
type DkimKeyPolicyFailure =
	| 'revoked'
	| 'key-type-mismatch'
	| 'hash-forbidden'
	| 'service-forbidden'
	| 'bad-key';

/**
 * Outcome of {@link resolveDkimKey}. A `weak-rsa` failure still carries the
 * record, because the DKIM verifier checks the record's `t=s` flag before it
 * applies the weak-key verdict.
 */
type DkimKeyResolution =
	| { readonly ok: true; readonly key: KeyObject; readonly record: DkimKeyRecord }
	| { readonly ok: false; readonly reason: DkimKeyLookupFailure | DkimKeyPolicyFailure }
	| { readonly ok: false; readonly reason: 'weak-rsa'; readonly record: DkimKeyRecord };

/** The algorithm a signature claims: the key type the record must carry and the hash `h=` must allow. */
interface DkimKeyRequirement {
	readonly keyType: 'rsa' | 'ed25519';
	readonly hash: 'sha1' | 'sha256';
}

/**
 * Fetch `${selector}._domainkey.${domain}`, pick the first parseable record and
 * apply the RFC 6376 §3.6.1 / RFC 8301 key policy, in this order: revoked or
 * wrong key type, an `h=` list that forbids `hash`, an explicit `s=` list that
 * names neither `email` nor `*` (absent `s=` defaults to `*`), a key that does
 * not decode, and an RSA modulus below 1024 bits. Never throws: a resolver
 * rejection becomes `dns-perm` for a no-record error (NXDOMAIN / NODATA) and
 * `dns-temp` for anything else.
 */
export async function resolveDkimKey(
	resolver: DkimDnsResolver,
	selector: string,
	domain: string,
	requirement: DkimKeyRequirement
): Promise<DkimKeyResolution> {
	let records: string[][];
	try {
		records = await resolver(`${selector}._domainkey.${domain}`, 'TXT');
	} catch (err) {
		return { ok: false, reason: isNoRecordDnsError(err) ? 'dns-perm' : 'dns-temp' };
	}
	const joined = records.map((chunks) => chunks.join('')).filter((r) => r !== '');
	if (joined.length === 0) {
		return { ok: false, reason: 'no-record' };
	}
	const record = joined.map((r) => parseDkimKeyRecord(r)).find((r) => !isKeyRecordError(r));
	if (record === undefined || isKeyRecordError(record)) {
		return { ok: false, reason: 'unparseable' };
	}

	if (record.revoked) {
		return { ok: false, reason: 'revoked' };
	}
	if (record.keyType !== requirement.keyType) {
		return { ok: false, reason: 'key-type-mismatch' };
	}
	if (record.hashAlgorithms !== undefined && !record.hashAlgorithms.includes(requirement.hash)) {
		return { ok: false, reason: 'hash-forbidden' };
	}
	if (
		record.serviceTypes.length > 0 &&
		!record.serviceTypes.includes('email') &&
		!record.serviceTypes.includes('*')
	) {
		return { ok: false, reason: 'service-forbidden' };
	}

	let key: KeyObject;
	try {
		key = buildPublicKey(record, requirement.keyType);
	} catch {
		return { ok: false, reason: 'bad-key' };
	}
	if (requirement.keyType === 'rsa') {
		const modulusLength = key.asymmetricKeyDetails?.modulusLength;
		if (modulusLength !== undefined && modulusLength < MIN_RSA_KEY_BITS) {
			return { ok: false, reason: 'weak-rsa', record };
		}
	}
	return { ok: true, key, record };
}

/**
 * Construct a Node public key from a parsed key record. Ed25519 keys are the raw
 * 32 bytes (RFC 8463), wrapped in an SPKI header (RFC 8410). RSA keys are
 * published as an SPKI SubjectPublicKeyInfo (RFC 6376 §3.6.1), which is also
 * what the mailauth oracle accepts — do NOT fall back to bare PKCS#1, or we
 * would verdict-diverge by accepting a key the oracle rejects.
 */
function buildPublicKey(record: DkimKeyRecord, keyType: 'rsa' | 'ed25519'): KeyObject {
	const material = Buffer.from(record.publicKey, 'base64');
	if (keyType === 'ed25519') {
		const der = Buffer.concat([ED25519_SPKI_PREFIX, material]);
		return createPublicKey({ key: der, format: 'der', type: 'spki' });
	}
	return createPublicKey({ key: material, format: 'der', type: 'spki' });
}
