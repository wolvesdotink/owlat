/**
 * Shared DKIM signature minter for the verify test suites.
 *
 * Every verify suite (`dkimVerify.differential`, `dkimVerify.ltag`,
 * `dkimAdversarial`, the evidence suites) needs to synthesize a signature —
 * relaxed/relaxed unless it asks for other `c=` halves — over the package's OWN
 * public `canon` API and prepend it to a raw message. This is the
 * single implementation they share so the signing rules — including the
 * oversigning rule that a repeated `h=` name with no remaining header
 * contributes NOTHING — never drift apart between suites.
 */

import { createHash, createSign, sign as cryptoSign, type KeyObject } from 'crypto';
import {
	canonicalizeBody,
	canonicalizeHeaderField,
	parseCanonicalization,
} from '../../../canon.js';

export interface MintOptions {
	/** Private key (PEM string or KeyObject) used to sign, or ignored when `bogusSignature` is set. */
	readonly privateKey: KeyObject | string;
	readonly domain: string;
	readonly selector: string;
	/** Full raw header fields (each `Name: value`, no CRLF) that precede the body. */
	readonly headers: readonly string[];
	/** The `h=` tag value (colon-separated, bottom-up per name). */
	readonly hTag: string;
	readonly body: string;
	/**
	 * Algorithm tag; the hash is derived (`rsa-sha1` -> sha1, else sha256).
	 * Defaults to rsa-sha256. `ed25519-sha256` signs the SHA-256 digest of the
	 * header input with a pure-EdDSA key (RFC 8463 §3), matching the verifier.
	 */
	readonly algTag?: 'rsa-sha256' | 'rsa-sha1' | 'ed25519-sha256';
	/** The `c=` tag value, signed with exactly these halves. Defaults to relaxed/relaxed. */
	readonly canonicalization?: string;
	/** Extra tags injected verbatim before `b=` (e.g. `'l=10; '`, `'t=1; x=2; '`). */
	readonly extraTags?: string;
	/** Limit the signed body length used for `bh` (mirrors an `l=` signer). */
	readonly bodyLimit?: number;
	/**
	 * When set, emit this literal `b=` value instead of a real signature — for
	 * fixtures that must reach a pre-crypto branch with a bogus signature.
	 */
	readonly bogusSignature?: string;
}

/**
 * Mint a signature (relaxed/relaxed unless `canonicalization` says otherwise)
 * over `headers` + `body` and return the raw message with the DKIM-Signature
 * header prepended.
 */
export function mintSignature(opts: MintOptions): Buffer {
	const algTag = opts.algTag ?? 'rsa-sha256';
	const hashAlg = algTag === 'rsa-sha1' ? 'sha1' : 'sha256';
	const cTag = opts.canonicalization ?? 'relaxed/relaxed';
	const { header: headerMode, body: bodyMode } = parseCanonicalization(cTag);

	let canonBody = canonicalizeBody(Buffer.from(opts.body, 'latin1'), bodyMode);
	if (opts.bodyLimit !== undefined) {
		canonBody = canonBody.subarray(0, opts.bodyLimit);
	}
	const bh = createHash(hashAlg).update(canonBody).digest('base64');
	const extra = opts.extraTags ?? '';
	const sigUnsigned =
		`DKIM-Signature: v=1; a=${algTag}; c=${cTag}; d=${opts.domain}; s=${opts.selector};` +
		` h=${opts.hTag}; bh=${bh}; ${extra}b=`;

	let b: string;
	if (opts.bogusSignature !== undefined) {
		b = opts.bogusSignature;
	} else {
		// Bottom-up per-name stacks, consumed exactly as `buildHeaderHashInput`
		// does: a repeated `h=` name with no remaining header contributes nothing.
		const stacks = new Map<string, string[]>();
		for (const h of opts.headers) {
			const name = h.slice(0, h.indexOf(':')).trim().toLowerCase();
			const stack = stacks.get(name);
			if (stack) {
				stack.push(h);
			} else {
				stacks.set(name, [h]);
			}
		}
		const names = opts.hTag
			.split(':')
			.map((n) => n.trim().toLowerCase())
			.filter((n) => n !== '');
		const parts: string[] = [];
		for (const name of names) {
			const raw = stacks.get(name)?.pop();
			if (raw === undefined) {
				continue;
			}
			parts.push(`${canonicalizeHeaderField(raw, headerMode)}\r\n`);
		}
		const headerInput = Buffer.from(
			parts.join('') + canonicalizeHeaderField(sigUnsigned, headerMode),
			'latin1'
		);
		b =
			algTag === 'ed25519-sha256'
				? cryptoSign(
						null,
						createHash('sha256').update(headerInput).digest(),
						opts.privateKey
					).toString('base64')
				: createSign(hashAlg).update(headerInput).sign(opts.privateKey, 'base64');
	}

	const message = `${opts.headers.join('\r\n')}\r\n\r\n${opts.body}`;
	return Buffer.from(`${sigUnsigned}${b}\r\n${message}`, 'latin1');
}
