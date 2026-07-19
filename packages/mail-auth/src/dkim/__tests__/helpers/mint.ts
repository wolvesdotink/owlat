/**
 * Shared DKIM signature minter for the verify test suites.
 *
 * All three verify suites (`dkimVerify.differential`, `dkimVerify.ltag`,
 * `dkimAdversarial`) need to synthesize a relaxed/relaxed signature over the
 * package's OWN public `canon` API and prepend it to a raw message. This is the
 * single implementation they share so the signing rules — including the
 * oversigning rule that a repeated `h=` name with no remaining header
 * contributes NOTHING — never drift apart between suites.
 */

import { createHash, createSign, type KeyObject } from 'crypto';
import { canonicalizeBodyRelaxed, canonicalizeHeaderField } from '../../../canon.js';

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
	/** Algorithm tag; the hash is derived (`rsa-sha1` -> sha1, else sha256). Defaults to rsa-sha256. */
	readonly algTag?: 'rsa-sha256' | 'rsa-sha1';
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
 * Mint a relaxed/relaxed signature over `headers` + `body` and return the raw
 * message with the DKIM-Signature header prepended.
 */
export function mintSignature(opts: MintOptions): Buffer {
	const algTag = opts.algTag ?? 'rsa-sha256';
	const hashAlg = algTag === 'rsa-sha1' ? 'sha1' : 'sha256';

	let canonBody = canonicalizeBodyRelaxed(Buffer.from(opts.body, 'latin1'));
	if (opts.bodyLimit !== undefined) {
		canonBody = canonBody.subarray(0, opts.bodyLimit);
	}
	const bh = createHash(hashAlg).update(canonBody).digest('base64');
	const extra = opts.extraTags ?? '';
	const sigUnsigned =
		`DKIM-Signature: v=1; a=${algTag}; c=relaxed/relaxed; d=${opts.domain}; s=${opts.selector};` +
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
			parts.push(`${canonicalizeHeaderField(raw, 'relaxed')}\r\n`);
		}
		const headerInput = Buffer.from(
			parts.join('') + canonicalizeHeaderField(sigUnsigned, 'relaxed'),
			'latin1'
		);
		b = createSign(hashAlg).update(headerInput).sign(opts.privateKey, 'base64');
	}

	const message = `${opts.headers.join('\r\n')}\r\n\r\n${opts.body}`;
	return Buffer.from(`${sigUnsigned}${b}\r\n${message}`, 'latin1');
}
