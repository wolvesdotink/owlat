import { dkimSign } from 'mailauth/lib/dkim/sign.js';
import type { DKIMSignatureData } from 'mailauth';

/** The signer options fixtures use: one key set per `signatureData` entry. */
export interface SignatureDataOptions {
	canonicalization: string;
	algorithm: string;
	signatureData: DKIMSignatureData[];
	/** The `t=` stamp for every signature. Defaults to `FIXTURE_SIGN_TIME`. */
	signTime?: Date;
}

/**
 * The fixed `t=` every fixture signature carries. mailauth 5.x, given no
 * `signTime`, reads the clock twice: once for the `t=` it signs and again for
 * the `t=` it writes. When the rounded second changes between the two (about 1
 * in 750 signatures), the written header no longer matches its signature and
 * every verifier returns `fail`. A fixed time also keeps fixtures reproducible.
 * No fixture sets `x=`, so a past time never expires.
 */
export const FIXTURE_SIGN_TIME = new Date('2026-06-17T12:00:00Z');

/** mailauth's `dkimSign` with the fixture `t=` stamp. */
export function mailauthDkimSign(message: Buffer, options: SignatureDataOptions) {
	return dkimSign(message, {
		...options,
		signTime: options.signTime ?? FIXTURE_SIGN_TIME,
	});
}
