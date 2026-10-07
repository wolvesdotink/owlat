import { dkimSign } from 'mailauth/lib/dkim/sign.js';
import type { DKIMSignOptions } from 'mailauth';

/** The options mailauth's signer actually reads: the key set lives on `signatureData`. */
export interface SignatureDataOptions {
	canonicalization: string;
	algorithm: string;
	signatureData: DKIMSignOptions[];
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

/**
 * mailauth's `dkimSign`, typed the way it runs. Its type definitions require
 * flat top-level `signingDomain` / `selector` / `privateKey`, but the signer
 * ignores those and signs once per `signatureData` entry.
 */
export function mailauthDkimSign(message: Buffer, options: SignatureDataOptions) {
	return dkimSign(message, {
		...options,
		signTime: options.signTime ?? FIXTURE_SIGN_TIME,
	} as unknown as DKIMSignOptions);
}
