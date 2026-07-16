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

import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'crypto';
import { resolveTxt } from 'dns/promises';
import {
	canonicalizeBody,
	canonicalizeHeaderField,
	parseCanonicalization,
	stripSignatureValue,
	type Canonicalization,
} from '../canon.js';
import type { DkimVerdict } from '../dmarc.js';
import { isKeyRecordError, parseDkimKeyRecord, type DkimKeyRecord } from './keyRecord.js';

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

/** DNS error codes that mean "no such record" — a permanent DKIM failure. */
const PERMANENT_DNS_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'NOTFOUND']);

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

		const signatures: DkimSignatureResult[] = [];
		for (const sigField of signatureFields.slice(0, MAX_SIGNATURES)) {
			signatures.push(
				await verifyOneSignature(sigField.raw, headerFields, body, resolver, nowSeconds)
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

/** A parsed raw header field: lowercased name plus verbatim bytes (no CRLF). */
interface HeaderField {
	readonly name: string;
	readonly raw: string;
}

/**
 * Split a raw message into its ordered header fields and its body. The header
 * block is decoded latin1 so canonicalization stays byte-exact; the body stays
 * a Buffer. Folded continuation lines are rejoined with CRLF into one field.
 */
function splitMessage(raw: Buffer): { headerFields: HeaderField[]; body: Buffer } {
	const crlfIdx = raw.indexOf('\r\n\r\n');
	const lfIdx = raw.indexOf('\n\n');
	let boundary = -1;
	let sepLen = 0;
	if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx <= lfIdx)) {
		boundary = crlfIdx;
		sepLen = 4;
	} else if (lfIdx !== -1) {
		boundary = lfIdx;
		sepLen = 2;
	}

	const headerBlock = (boundary === -1 ? raw : raw.subarray(0, boundary)).toString('latin1');
	const body = boundary === -1 ? Buffer.alloc(0) : raw.subarray(boundary + sepLen);
	return { headerFields: parseHeaderFields(headerBlock), body };
}

/** Parse a header block into ordered fields, rejoining folded lines. */
function parseHeaderFields(headerBlock: string): HeaderField[] {
	const fields: HeaderField[] = [];
	let current: string | null = null;
	const flush = (): void => {
		if (current === null) {
			return;
		}
		const colon = current.indexOf(':');
		const name = (colon === -1 ? current : current.slice(0, colon)).trim().toLowerCase();
		fields.push({ name, raw: current });
		current = null;
	};

	for (const line of headerBlock.split('\n')) {
		const content = line.endsWith('\r') ? line.slice(0, -1) : line;
		if ((content.startsWith(' ') || content.startsWith('\t')) && current !== null) {
			current += `\r\n${content}`;
		} else {
			flush();
			current = content;
		}
	}
	flush();
	return fields;
}

/** Strip all whitespace — for base64 (`b=`, `bh=`) and colon lists (`h=`). */
function stripWsp(value: string): string {
	return value.replace(/[ \t\r\n]+/g, '');
}

/** Parse the tag=value list out of a DKIM-Signature header value. */
function parseSignatureTags(rawField: string): Map<string, string> {
	const colon = rawField.indexOf(':');
	const value = colon === -1 ? rawField : rawField.slice(colon + 1);
	const tags = new Map<string, string>();
	for (const segment of value.split(';')) {
		const eq = segment.indexOf('=');
		if (eq === -1) {
			continue;
		}
		const name = segment.slice(0, eq).trim();
		if (name === '') {
			continue;
		}
		if (!tags.has(name)) {
			tags.set(name, segment.slice(eq + 1).trim());
		}
	}
	return tags;
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
 * Verify one DKIM signature and return its verdict. Any structurally-broken
 * signature yields `permerror`; a body/crypto mismatch yields `fail`; a
 * transient DNS failure yields `temperror`. Never throws.
 */
async function verifyOneSignature(
	sigField: string,
	headerFields: readonly HeaderField[],
	body: Buffer,
	resolver: DkimDnsResolver,
	nowSeconds: number
): Promise<DkimSignatureResult> {
	const tags = parseSignatureTags(sigField);
	const domain = tags.get('d');
	const selector = tags.get('s');
	const algorithmRaw = tags.get('a');
	const base: DkimSignatureResult = {
		verdict: 'permerror',
		...(domain !== undefined ? { domain } : {}),
		...(selector !== undefined ? { selector } : {}),
		...(algorithmRaw !== undefined ? { algorithm: algorithmRaw } : {}),
	};
	const withVerdict = (verdict: DkimVerdict): DkimSignatureResult => ({ ...base, verdict });

	// Required tags (RFC 6376 §3.5): v a b bh d s h.
	const version = tags.get('v');
	const bTag = tags.get('b');
	const bhTag = tags.get('bh');
	const hTag = tags.get('h');
	if (
		version !== '1' ||
		bTag === undefined ||
		bhTag === undefined ||
		domain === undefined ||
		selector === undefined ||
		hTag === undefined
	) {
		return withVerdict('permerror');
	}

	const algorithm = parseAlgorithm(algorithmRaw);
	if (algorithm === undefined) {
		return withVerdict('permerror');
	}

	const { header: headerMode, body: bodyMode } = parseCanonicalization(tags.get('c'));

	// --- Body hash (RFC 6376 §3.7) ---------------------------------------
	const lTag = tags.get('l');
	const hasLengthTag = lTag !== undefined && lTag !== '';
	let canonBody = canonicalizeBody(body, bodyMode);
	if (lTag !== undefined && lTag !== '') {
		const limit = Number.parseInt(lTag, 10);
		if (Number.isFinite(limit) && limit >= 0 && limit < canonBody.length) {
			canonBody = canonBody.subarray(0, limit);
		}
	}
	const computedBodyHash = createHash(algorithm.hash).update(canonBody).digest('base64');
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

	// Expiry (RFC 6376 §3.5 x=): an expired-but-valid signature fails.
	const xTag = tags.get('x');
	if (xTag !== undefined && xTag !== '') {
		const expiry = Number.parseInt(xTag, 10);
		if (Number.isFinite(expiry) && nowSeconds > expiry) {
			return withVerdict('fail');
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
		// A header listed in h= but not present is a null header (§3.7): it
		// contributes an empty canonicalized field.
		parts.push(canonicalizeHeaderField(raw ?? `${name}:`, mode));
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
	const code =
		typeof err === 'object' && err !== null && 'code' in err
			? String((err as { code: unknown }).code)
			: '';
	return PERMANENT_DNS_CODES.has(code) ? 'permerror' : 'temperror';
}

/** Constant-time-ish string compare for hash equality (length-safe). */
function timingSafeEqualStrings(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/** Default resolver: Node `dns/promises` resolveTxt (`string[][]`). */
const defaultResolver: DkimDnsResolver = (name) => resolveTxt(name);
