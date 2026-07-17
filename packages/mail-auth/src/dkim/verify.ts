/**
 * RFC 6376 / RFC 8463 / RFC 8601 inbound DKIM verifier.
 *
 * Replaces the `mailauth`-backed `apps/mta/src/bounce/inboundDkim.ts` on the
 * inbound path. It reduces a message's DKIM-Signature header(s) to the single
 * RFC 8601 verdict Owlat records (`mailMessages.dkimResult`), with three
 * invariants carried over verbatim and one sanctioned improvement:
 *
 *   - STRONGEST-WINS across multiple signatures — precedence identical to the
 *     old `inboundDkim.pickVerdict` (pass > fail > permerror > temperror >
 *     neutral > none): one valid signature authenticates the message
 *     (RFC 6376 §6.1).
 *   - NEVER THROWS (locked decision D7): any internal error — a hostile header,
 *     a broken key record, a DNS explosion — becomes `temperror`, so an
 *     already-accepted message is never dropped because verification crashed.
 *   - Both `rsa-sha256` and `ed25519-sha256` (RFC 8463) verify; `rsa-sha1` is
 *     verified but POLICY-FAILED per RFC 8301 (it is deprecated and MUST NOT be
 *     treated as a pass).
 *   - SANCTIONED IMPROVEMENT (locked decision D2): the `l=` body-length tag is
 *     honored cryptographically but a signature that carries it is CAPPED AT
 *     `neutral` — never `pass`. `l=` lets an attacker append unsigned content
 *     to a validly-signed body, so we refuse to call such a message
 *     authenticated. This is the one intentional divergence from the old
 *     library and is pinned by `dkimVerify.ltag.test.ts`.
 *
 * Canonicalization is delegated to the shared `../canon.ts` public API (D4) so
 * the verifier and the outbound signer (A3) share ONE implementation.
 */

import {
	createHash,
	createPublicKey,
	timingSafeEqual,
	verify as cryptoVerify,
	type KeyObject,
} from 'crypto';
import { resolveTxt } from 'dns/promises';
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
import { splitMessage, type HeaderField } from './message.js';
import { parseTagList } from './tagList.js';

/**
 * The DNS surface the verifier needs: a TXT lookup returning the raw
 * character-strings of each record. Shape-compatible with `mailauth`'s
 * resolver and with the mocked resolvers the existing inbound tests use, so a
 * single resolver drives both sides of the differential suite.
 */
export type DkimDnsResolver = (name: string, rrtype: 'TXT') => Promise<string[][]>;

export interface VerifyDkimOptions {
	/** Injectable TXT resolver (defaults to Node `dns/promises` resolveTxt). */
	readonly resolver?: DkimDnsResolver;
	/** Verification time in UNIX seconds (defaults to now); for `x=` expiry. */
	readonly now?: number;
}

/** Per-signature verdict, exposed so tests can inspect individual signatures. */
export interface DkimSignatureResult {
	readonly verdict: DkimVerdict;
	readonly domain?: string;
	readonly selector?: string;
	readonly algorithm?: string;
}

/** The message-level DKIM outcome. */
export interface DkimVerifyResult {
	/** The strongest-wins RFC 8601 verdict for the whole message. */
	readonly result: DkimVerdict;
	/** Signing domain (`d=`) of the verdict-deciding signature, if any. */
	readonly domain?: string;
	/** Every signature's individual verdict, in document order. */
	readonly signatures: readonly DkimSignatureResult[];
}

/** DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** RFC 8601 verdict precedence — MUST match `inboundDkim.pickVerdict`. */
const VERDICT_RANK: Record<DkimVerdict, number> = {
	pass: 6,
	fail: 5,
	permerror: 4,
	temperror: 3,
	neutral: 2,
	none: 1,
};

/**
 * Upper bound on the number of DKIM-Signature headers we evaluate. Legitimate
 * mail carries a handful; a hostile message can carry thousands to force a
 * key-lookup / hash storm (the "signature bomb"). We evaluate the first
 * `MAX_SIGNATURES` in document order and ignore the rest — a bounded-safety
 * measure that only affects pathological messages, never real mail.
 */
const MAX_SIGNATURES = 10;

/**
 * Verify the DKIM signature(s) on a raw RFC 822 message.
 *
 * Never throws (D7): the whole body is wrapped so any unexpected failure
 * surfaces as `temperror`.
 */
export async function verifyDkim(
	raw: Buffer,
	options: VerifyDkimOptions = {}
): Promise<DkimVerifyResult> {
	try {
		const resolver = options.resolver ?? defaultResolver;
		const nowSeconds = options.now ?? Math.floor(Date.now() / 1000);

		const { headerFields, body } = splitMessage(raw);
		const signatureFields = headerFields.filter((f) => f.name === 'dkim-signature');
		if (signatureFields.length === 0) {
			return { result: 'none', signatures: [] };
		}

		// Cache body canon + full-body hash across the signature loop: both are
		// O(body) and depend only on (bodyMode) / (bodyMode, hash), so a multi-sig
		// message costs one pass per combination, not one per signature.
		const bodyCache: BodyHashCache = {
			canon: new Map<Canonicalization, Buffer>(),
			hash: new Map<string, string>(),
		};

		const signatures: DkimSignatureResult[] = [];
		for (const sigField of signatureFields.slice(0, MAX_SIGNATURES)) {
			signatures.push(
				await verifyMessageSignature(
					sigField.raw,
					headerFields,
					body,
					resolver,
					nowSeconds,
					bodyCache
				)
			);
		}

		// Strongest-wins reduction (RFC 6376 §6.1), matching pickVerdict.
		let best: DkimSignatureResult = { verdict: 'none' };
		for (const sig of signatures) {
			if (VERDICT_RANK[sig.verdict] > VERDICT_RANK[best.verdict]) {
				best = sig;
			}
		}

		return best.domain !== undefined
			? { result: best.verdict, domain: best.domain, signatures }
			: { result: best.verdict, signatures };
	} catch {
		// D7: an unexpected internal error is a transient result, never a throw.
		return { result: 'temperror', signatures: [] };
	}
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

/** Cross-signature cache: canonicalized body by mode, full-body hash by mode+alg. */
interface BodyHashCache {
	readonly canon: Map<Canonicalization, Buffer>;
	readonly hash: Map<string, string>;
}

/**
 * Verify one DKIM-family signature: `permerror` if structurally broken, `fail` on
 * a body/crypto mismatch, `temperror` on a transient DNS failure. Never throws.
 * Shared with the ARC verifier, which passes an ARC-Message-Signature (RFC 8617
 * §4.1.2 — a DKIM signature MINUS `v=`) with `requireVersion: false`, so signer,
 * DKIM and ARC AMS all canonicalize/hash through this ONE core (U4). `bodyCache`
 * is optional (a fresh one is allocated per single-signature call).
 */
export async function verifyMessageSignature(
	sigField: string,
	headerFields: readonly HeaderField[],
	body: Buffer,
	resolver: DkimDnsResolver,
	nowSeconds: number,
	bodyCache?: BodyHashCache,
	requireVersion = true
): Promise<DkimSignatureResult> {
	const cache: BodyHashCache = bodyCache ?? {
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

/** Default resolver: Node `dns/promises` resolveTxt (`string[][]`). */
const defaultResolver: DkimDnsResolver = (name) => resolveTxt(name);
