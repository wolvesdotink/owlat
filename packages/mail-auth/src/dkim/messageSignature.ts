/**
 * The single DKIM-family signature core (RFC 6376 §3.5-§3.7 / RFC 8463), shared
 * by the inbound DKIM verifier (`./verify.ts`), the outbound signer, and the ARC
 * verifier (`../arc/*`). ARC's AMS is a DKIM signature MINUS the `v=` tag
 * (RFC 8617 §4.1.2), so signer, DKIM and ARC AMS all canonicalize/hash through
 * this ONE core (U4) — there is no second canonicalization or hashing path.
 *
 * Canonicalization is delegated to the shared `../canon.ts` public API (D4).
 */

import {
	createHash,
	createPublicKey,
	timingSafeEqual,
	verify as cryptoVerify,
	type KeyObject,
} from 'crypto';
import {
	canonicalizeBody,
	canonicalizeHeaderField,
	parseCanonicalization,
	stripSignatureValue,
	type Canonicalization,
} from '../canon.js';
import type { DkimVerdict } from '../dmarc.js';
import { isNoRecordDnsError } from '../dnsErrors.js';
import { isKeyRecordError, parseDkimKeyRecord, type DkimKeyRecord } from './keyRecord.js';
import type { HeaderField } from './message.js';
import { parseTagList } from './tagList.js';

/**
 * The DNS surface the verifier needs: a TXT lookup returning the raw
 * character-strings of each record. Shape-compatible with `mailauth`'s
 * resolver and with the mocked resolvers the existing inbound tests use, so a
 * single resolver drives both sides of the differential suite.
 */
export type DkimDnsResolver = (name: string, rrtype: 'TXT') => Promise<string[][]>;

/** Per-signature verdict, exposed so tests can inspect individual signatures. */
export interface DkimSignatureResult {
	readonly verdict: DkimVerdict;
	readonly domain?: string;
	readonly selector?: string;
	readonly algorithm?: string;
}

/** Cross-signature cache: canonicalized body by mode, full-body hash by mode+alg. */
export interface BodyHashCache {
	readonly canon: Map<Canonicalization, Buffer>;
	readonly hash: Map<string, string>;
}

/** Options for {@link verifyMessageSignature}; both default to the DKIM behaviour. */
export interface MessageSignatureOptions {
	/**
	 * Cross-signature body-hash cache to reuse across a multi-signature message; a
	 * fresh one is allocated when omitted (the single-signature / ARC-AMS case).
	 */
	readonly bodyCache?: BodyHashCache;
	/**
	 * Require the `v=1` tag. DKIM mandates it; ARC's AMS omits it (RFC 8617 §4.1.2),
	 * so the ARC verifier passes `false`.
	 */
	readonly requireVersion?: boolean;
}

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

/** True for an RSA key whose modulus is below the RFC 8301 §3.2 floor. */
function isWeakRsaKey(key: KeyObject): boolean {
	const modulusLength = key.asymmetricKeyDetails?.modulusLength;
	return modulusLength !== undefined && modulusLength < MIN_RSA_KEY_BITS;
}

/** Strip all whitespace — for base64 (`b=`, `bh=`) and colon lists (`h=`). */
function stripWsp(value: string): string {
	return value.replace(/[ \t\r\n]+/g, '');
}

/** Parse the DKIM-Signature value: case-sensitive names, trimmed values, first-wins. */
function parseSignatureTags(rawField: string): Map<string, string> {
	const colon = rawField.indexOf(':');
	const value = colon === -1 ? rawField : rawField.slice(colon + 1);
	return parseTagList(value, { lowercaseName: false, normalizeValue: (raw) => raw.trim() });
}

/** The parsed algorithm halves of an `a=` tag. */
interface DkimAlgorithm {
	readonly keyType: 'rsa' | 'ed25519';
	readonly hash: 'sha1' | 'sha256';
}

function parseAlgorithm(a: string | undefined): DkimAlgorithm | undefined {
	switch ((a ?? '').toLowerCase()) {
		case 'rsa-sha256':
			return { keyType: 'rsa', hash: 'sha256' };
		case 'rsa-sha1':
			return { keyType: 'rsa', hash: 'sha1' };
		case 'ed25519-sha256':
			return { keyType: 'ed25519', hash: 'sha256' };
		default:
			return undefined;
	}
}

/**
 * True when a `c=` value names only known canonicalization halves
 * (`header[/body]`, each `simple` or `relaxed`). An unknown or malformed `c=`
 * is a signature the replaced mailauth path SKIPS (-> none), so the verifier
 * rejects it rather than falling back to simple/simple and evaluating it.
 */
function isValidCanonicalizationTag(c: string): boolean {
	const parts = c.split('/');
	if (parts.length > 2) {
		return false;
	}
	return parts.every((part) => part === 'simple' || part === 'relaxed');
}

/**
 * Verify one DKIM-family signature: `permerror` if structurally broken, `fail` on
 * a body/crypto mismatch, `temperror` on a transient DNS failure. Never throws.
 * Shared with the ARC verifier, which passes an ARC-Message-Signature (RFC 8617
 * §4.1.2 — a DKIM signature MINUS `v=`) with `requireVersion: false`, so signer,
 * DKIM and ARC AMS all canonicalize/hash through this ONE core (U4).
 */
export async function verifyMessageSignature(
	sigField: string,
	headerFields: readonly HeaderField[],
	body: Buffer,
	resolver: DkimDnsResolver,
	nowSeconds: number,
	options: MessageSignatureOptions = {}
): Promise<DkimSignatureResult> {
	const requireVersion = options.requireVersion ?? true;
	const cache: BodyHashCache = options.bodyCache ?? {
		canon: new Map<Canonicalization, Buffer>(),
		hash: new Map<string, string>(),
	};
	const tags = parseSignatureTags(sigField);
	const domain = tags.get('d');
	const selector = tags.get('s');
	const algorithmRaw = tags.get('a');
	// The caller always supplies the verdict via `withVerdict`, so `base` carries
	// only the identifying fields — omitting `verdict` keeps the type honest (an
	// unusable signature returns `none`, not the misleading `permerror` a dead
	// default would imply).
	const base: Omit<DkimSignatureResult, 'verdict'> = {
		...(domain !== undefined ? { domain } : {}),
		...(selector !== undefined ? { selector } : {}),
		...(algorithmRaw !== undefined ? { algorithm: algorithmRaw } : {}),
	};
	const withVerdict = (verdict: DkimVerdict): DkimSignatureResult => ({ ...base, verdict });

	// Required tags (RFC 6376 §3.5): v a b bh d s h. ARC's AMS omits `v=` (RFC 8617
	// §4.1.2), so the ARC caller drops the `v=1` gate via `requireVersion: false`.
	const version = tags.get('v');
	const bTag = tags.get('b');
	const bhTag = tags.get('bh');
	const hTag = tags.get('h');
	if (
		(requireVersion && version !== '1') ||
		bTag === undefined ||
		bhTag === undefined ||
		domain === undefined ||
		selector === undefined ||
		hTag === undefined
	) {
		// A signature missing a required tag is UNUSABLE, not permanently broken:
		// mailauth (and the replaced `inboundDkim.normalizeStatus`) SKIP it, so the
		// message reduces to `none` ("not signed"). Returning `permerror` (rank 4)
		// would outrank a sibling signature's temperror/neutral in strongest-wins
		// and mis-record single-signature mail as a permanent error, so we match
		// the skip -> none semantics of the path we replace.
		return withVerdict('none');
	}

	const algorithm = parseAlgorithm(algorithmRaw);
	if (algorithm === undefined) {
		// Unknown / unsupported `a=` (e.g. rsa-sha512): mailauth skips the
		// signature (-> none), so we do too rather than record a `permerror`.
		return withVerdict('none');
	}

	const cTag = tags.get('c');
	if (cTag !== undefined && !isValidCanonicalizationTag(cTag)) {
		// An unrecognized `c=` canonicalization is skipped by mailauth (-> none);
		// never silently fall back to simple/simple and evaluate the signature.
		return withVerdict('none');
	}
	const { header: headerMode, body: bodyMode } = parseCanonicalization(cTag);

	// --- Body hash (RFC 6376 §3.7) ---------------------------------------
	const lTag = tags.get('l');
	const hasLengthTag = lTag !== undefined && lTag !== '';

	let canonBody = cache.canon.get(bodyMode);
	if (canonBody === undefined) {
		canonBody = canonicalizeBody(body, bodyMode);
		cache.canon.set(bodyMode, canonBody);
	}

	let computedBodyHash: string;
	if (hasLengthTag) {
		const rawLimit = lTag ?? ''; // non-empty here; `?? ''` only narrows the type
		const limit = Number.parseInt(rawLimit, 10);
		// RFC 6376 §3.7/§6.1.1: an unparseable or over-long `l=` is a PERMFAIL —
		// never silently hash the whole body.
		if (!/^\d+$/.test(rawLimit) || limit > canonBody.length) {
			return withVerdict('permerror');
		}
		const effectiveBody = limit < canonBody.length ? canonBody.subarray(0, limit) : canonBody;
		computedBodyHash = createHash(algorithm.hash).update(effectiveBody).digest('base64');
	} else {
		const cacheKey = `${bodyMode}:${algorithm.hash}`;
		const cached = cache.hash.get(cacheKey);
		if (cached !== undefined) {
			computedBodyHash = cached;
		} else {
			computedBodyHash = createHash(algorithm.hash).update(canonBody).digest('base64');
			cache.hash.set(cacheKey, computedBodyHash);
		}
	}
	if (!timingSafeEqualStrings(computedBodyHash, stripWsp(bhTag))) {
		// Body hash mismatch — the body changed after signing (PERMFAIL).
		return withVerdict('fail');
	}

	// --- Public key retrieval --------------------------------------------
	const keyName = `${selector}._domainkey.${domain}`;
	let keyRecord: DkimKeyRecord;
	try {
		const records = await resolver(keyName, 'TXT');
		const joined = records.map((chunks) => chunks.join('')).filter((r) => r !== '');
		if (joined.length === 0) {
			return withVerdict('permerror');
		}
		const parsed = joined.map((r) => parseDkimKeyRecord(r)).find((r) => !isKeyRecordError(r));
		if (parsed === undefined || isKeyRecordError(parsed)) {
			return withVerdict('permerror');
		}
		keyRecord = parsed;
	} catch (err) {
		return withVerdict(classifyDnsError(err));
	}

	// Revoked (empty p=), key/alg mismatch, or a hash the key forbids: PERMFAIL.
	if (keyRecord.revoked || keyRecord.keyType !== algorithm.keyType) {
		return withVerdict('permerror');
	}
	if (
		keyRecord.hashAlgorithms !== undefined &&
		!keyRecord.hashAlgorithms.includes(algorithm.hash)
	) {
		return withVerdict('permerror');
	}

	// --- Signature verification (RFC 6376 §3.7 / RFC 8463) ---------------
	let publicKey: KeyObject;
	try {
		publicKey = buildPublicKey(keyRecord, algorithm.keyType);
	} catch {
		return withVerdict('permerror');
	}

	// RFC 8301 §3.2: an RSA key shorter than 1024 bits is a policy failure, not a
	// pass — a factorable modulus makes the signature forgeable. mailauth records
	// a policy/weak-key result; we mirror the same permanent non-pass verdict the
	// rsa-sha1 deprecation uses below (`fail`), NOT a throw (=> `permerror`) and
	// NOT `temperror`. Checked BEFORE the crypto verify so a valid signature over
	// a weak key can never reach `pass`.
	if (algorithm.keyType === 'rsa' && isWeakRsaKey(publicKey)) {
		return withVerdict('fail');
	}

	const headerInput = buildHeaderHashInput(headerFields, hTag, sigField, headerMode);
	const signature = Buffer.from(stripWsp(bTag), 'base64');
	let cryptoOk: boolean;
	try {
		cryptoOk =
			algorithm.keyType === 'ed25519'
				? cryptoVerify(
						null,
						createHash('sha256').update(headerInput).digest(),
						publicKey,
						signature
					)
				: cryptoVerify(algorithm.hash, headerInput, publicKey, signature);
	} catch {
		return withVerdict('permerror');
	}

	if (!cryptoOk) {
		return withVerdict('fail');
	}

	// Signature is cryptographically valid from here on.

	// Timestamp / expiry (RFC 6376 §3.5), matching the replaced mailauth /
	// inboundDkim path rather than the RFC's PERMFAIL: a crypto-valid signature
	// that is EXPIRED (x= in the past) or carries an INVALID expiration
	// (x= < t=; §3.5 requires x= be greater than t=) is recorded `neutral`. It
	// neither authenticates the message nor, as a `fail`, outranks a sibling
	// neutral in strongest-wins. (mailauth: "signature expired" / "invalid
	// expiration" -> neutral; the old path recorded neutral for both.)
	// A numeric tag is only honoured when the WHOLE value is digits: mailauth
	// parses `x=`/`t=` with `Number(...)` over the entire string, so trailing
	// garbage (`x=500abc`) yields NaN and the tag is dropped (no expiry check).
	// `Number.parseInt` would accept the `500` prefix and diverge — so we use the
	// same full-string digit guard the `l=` path uses above.
	const parseNumericTag = (value: string | undefined): number | undefined =>
		value !== undefined && /^\d+$/.test(value) ? Number.parseInt(value, 10) : undefined;
	const expiry = parseNumericTag(tags.get('x'));
	if (expiry !== undefined) {
		if (nowSeconds > expiry) {
			return withVerdict('neutral');
		}
		const timestamp = parseNumericTag(tags.get('t'));
		if (timestamp !== undefined && expiry < timestamp) {
			return withVerdict('neutral');
		}
	}

	// rsa-sha1 verifies but is policy-failed (RFC 8301 deprecation).
	if (algorithm.hash === 'sha1') {
		return withVerdict('fail');
	}

	// D2 sanctioned improvement: an `l=` signature is capped at neutral.
	if (hasLengthTag) {
		return withVerdict('neutral');
	}

	return withVerdict('pass');
}

/**
 * Build the byte string over which the DKIM signature is computed: the
 * canonicalized signed headers named by `h=` (each selected bottom-up so a
 * later-added duplicate can't be swapped in), followed by the canonicalized
 * DKIM-Signature header itself with its `b=` value emptied and NO trailing CRLF.
 */
function buildHeaderHashInput(
	headerFields: readonly HeaderField[],
	hTag: string,
	sigField: string,
	mode: Canonicalization
): Buffer {
	// Per-name stacks of raw fields in document order; consumed from the bottom.
	const stacks = new Map<string, string[]>();
	for (const field of headerFields) {
		const stack = stacks.get(field.name);
		if (stack) {
			stack.push(field.raw);
		} else {
			stacks.set(field.name, [field.raw]);
		}
	}

	const names = hTag
		.split(':')
		.map((n) => n.trim().toLowerCase())
		.filter((n) => n !== '');

	const parts: string[] = [];
	for (const name of names) {
		const raw = stacks.get(name)?.pop();
		// A name in h= with no (remaining) matching header contributes NOTHING —
		// not even an empty `name:` field or a CRLF — matching mailauth
		// (`getSigningHeaderLines`) / OpenDKIM. This is what lets the standard
		// oversigning defense (`h=from:from`, one From header) verify; a synthetic
		// `${name}:`+CRLF would false-`fail` that legitimate, very common mail.
		if (raw === undefined) {
			continue;
		}
		parts.push(canonicalizeHeaderField(raw, mode));
	}

	const sigCanon = canonicalizeHeaderField(stripSignatureValue(sigField), mode);
	const joined = parts.map((p) => `${p}\r\n`).join('') + sigCanon;
	return Buffer.from(joined, 'latin1');
}

/** Construct a Node public key from a parsed DKIM key record. */
function buildPublicKey(record: DkimKeyRecord, keyType: 'rsa' | 'ed25519'): KeyObject {
	const material = Buffer.from(record.publicKey, 'base64');
	if (keyType === 'ed25519') {
		const der = Buffer.concat([ED25519_SPKI_PREFIX, material]);
		return createPublicKey({ key: der, format: 'der', type: 'spki' });
	}
	return createPublicKey({ key: material, format: 'der', type: 'spki' });
}

/** Classify a resolver rejection into a permanent vs transient DKIM verdict. */
function classifyDnsError(err: unknown): DkimVerdict {
	return isNoRecordDnsError(err) ? 'permerror' : 'temperror';
}

/**
 * Constant-time equality for base64 hash strings via `crypto.timingSafeEqual`,
 * which needs equal-length buffers (hence the length short-circuit first).
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
	const ab = Buffer.from(a, 'latin1');
	const bb = Buffer.from(b, 'latin1');
	if (ab.length !== bb.length) {
		return false;
	}
	return timingSafeEqual(ab, bb);
}
