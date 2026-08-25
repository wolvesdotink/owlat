/**
 * The single DKIM-family signature core (RFC 6376 §3.5-§3.7 / RFC 8463), shared
 * by the inbound DKIM verifier (`./verify.ts`), the outbound signer, and the ARC
 * verifier (`../arc/*`). ARC's AMS is a DKIM signature MINUS the `v=` tag
 * (RFC 8617 §4.1.2), so signer, DKIM and ARC AMS all canonicalize/hash through
 * this ONE core (U4) — there is no second canonicalization or hashing path.
 *
 * Canonicalization is delegated to the shared `../canon.ts` public API (D4).
 */

import { createHash, verify as cryptoVerify, type KeyObject } from 'crypto';
import { canonicalizeBody, parseCanonicalization, type Canonicalization } from '../canon.js';
import type { DkimVerdict } from '../dmarc.js';
import {
	createEvidenceCollector,
	parseSignedHeaderNames,
	type DkimSignatureEvidence,
} from './evidence.js';
import { isKeyRecordError, parseDkimKeyRecord, type DkimKeyRecord } from './keyRecord.js';
import type { HeaderField } from './message.js';
import {
	buildHeaderHashInput,
	buildPublicKey,
	classifyDnsError,
	timingSafeEqualStrings,
} from './signatureCrypto.js';
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
	/**
	 * Passive OSTR §7.2 evidence tap: called once per signature attempt that
	 * reached DNS key resolution, whatever the verdict. Anything it throws is
	 * swallowed — the verification result is never affected.
	 */
	readonly onSignatureEvidence?: (evidence: DkimSignatureEvidence) => void;
}

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

/** Lowercase a DKIM domain for identity comparisons. */
function normalizeDkimDomain(domain: string): string {
	return stripWsp(domain).toLowerCase();
}

/**
 * Resolve the AUID (`i=`) domain, defaulting to the SDID (`d=`), and enforce
 * RFC 6376 §6.1.1's same-domain-or-subdomain relationship. `i=` uses a literal
 * final `@` separator; any `@` belonging to the local-part must be DKIM-QP
 * encoded, so `lastIndexOf` safely finds the domain boundary.
 */
function signatureIdentityDomain(
	identity: string | undefined,
	signingDomain: string
): string | null {
	const sdid = normalizeDkimDomain(signingDomain);
	if (sdid === '') return null;
	if (identity === undefined) return sdid;

	const compact = stripWsp(identity);
	const at = compact.lastIndexOf('@');
	if (at < 0 || at === compact.length - 1) return null;
	const auidDomain = normalizeDkimDomain(compact.slice(at + 1));
	if (auidDomain === '') return null;
	if (auidDomain !== sdid && !auidDomain.endsWith(`.${sdid}`)) return null;
	return auidDomain;
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
	// OSTR §7.2 evidence tap. The collector stays silent until it is armed at the
	// key lookup, so a signature that never reached DNS (missing tags, unknown
	// `a=`, a body-hash mismatch) produces no evidence — there is no key record
	// to describe. Every exit runs through `withVerdict`, so each post-DNS attempt
	// reports exactly once, whatever the verdict.
	const evidence = createEvidenceCollector(options.onSignatureEvidence, sigField, headerFields);
	const withVerdict = (verdict: DkimVerdict): DkimSignatureResult => {
		evidence.report(verdict);
		return { ...base, verdict };
	};

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

	// RFC 6376 §6.1.1: From MUST be signed. Merely requiring a non-empty `h=`
	// lets a cryptographically valid signature authenticate only attacker-chosen
	// headers/body while leaving the author identity replaceable, which must never
	// feed a `pass` into DMARC.
	if (!parseSignedHeaderNames(hTag).includes('from')) {
		return withVerdict('permerror');
	}

	// DKIM's AUID defaults to `@d`. When explicit, its domain must equal `d=` or
	// be a subdomain; an unrelated identity is malformed (RFC 6376 §6.1.1).
	// ARC-Message-Signature replaces the AUID with its numeric instance `i=`
	// (RFC 8617 §4.1.2), so the ARC caller's `requireVersion: false` deliberately
	// bypasses AUID semantics while retaining the shared From/service/crypto gates.
	const identityDomain = requireVersion
		? signatureIdentityDomain(tags.get('i'), domain)
		: normalizeDkimDomain(domain);
	if (identityDomain === null) {
		return withVerdict('permerror');
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
	// Arm the evidence tap here: from this point every exit has reached DNS key
	// resolution and reports. `dnsKeyRecordTxt` is filled in once a usable record
	// is chosen and stays `''` when the lookup fails or yields nothing usable.
	evidence.arm({
		domain,
		selector,
		// `parseAlgorithm` already returned a supported pair above, which is
		// impossible for an absent `a=`; the `?? ''` only narrows the type (same
		// precedent as `rawLimit` above) and never actually yields `''`.
		algorithm: algorithmRaw ?? '',
		usesBodyLengthTag: hasLengthTag,
		hTag,
		bodyHash: stripWsp(bhTag),
	});

	const keyName = `${selector}._domainkey.${domain}`;
	let keyRecord: DkimKeyRecord;
	try {
		const records = await resolver(keyName, 'TXT');
		const joined = records.map((chunks) => chunks.join('')).filter((r) => r !== '');
		if (joined.length === 0) {
			return withVerdict('permerror');
		}
		let parsed: DkimKeyRecord | undefined;
		for (const txt of joined) {
			const candidate = parseDkimKeyRecord(txt);
			if (!isKeyRecordError(candidate)) {
				parsed = candidate;
				evidence.recordKeyRecord(txt);
				break;
			}
		}
		if (parsed === undefined) {
			return withVerdict('permerror');
		}
		keyRecord = parsed;
	} catch (err) {
		return withVerdict(classifyDnsError(err));
	}

	// Revoked (empty p=), key/alg mismatch, a hash the key forbids, or a key whose
	// explicit service list does not authorize email: PERMFAIL. `s=` is optional
	// and defaults to `*`, represented by an empty parsed list; when present it
	// must name either `email` or `*` (RFC 6376 §3.6.1).
	if (keyRecord.revoked || keyRecord.keyType !== algorithm.keyType) {
		return withVerdict('permerror');
	}
	if (
		keyRecord.hashAlgorithms !== undefined &&
		!keyRecord.hashAlgorithms.includes(algorithm.hash)
	) {
		return withVerdict('permerror');
	}
	if (
		keyRecord.serviceTypes.length > 0 &&
		!keyRecord.serviceTypes.includes('email') &&
		!keyRecord.serviceTypes.includes('*')
	) {
		return withVerdict('permerror');
	}
	// `t=s` prohibits subdomain AUIDs even though the general i=/d= relationship
	// allows them (RFC 6376 §3.6.1).
	if (
		requireVersion &&
		keyRecord.flags.includes('s') &&
		identityDomain !== normalizeDkimDomain(domain)
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
	evidence.recordKey(publicKey, algorithm.keyType);

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
