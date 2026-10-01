import { dkimSign } from 'mailauth/lib/dkim/sign.js';
import type { DKIMSignOptions } from 'mailauth';

/** The options mailauth's signer actually reads: the key set lives on `signatureData`. */
export interface SignatureDataOptions {
	canonicalization: string;
	algorithm: string;
	signatureData: DKIMSignOptions[];
}

/**
 * mailauth's `dkimSign`, typed the way it runs. Its type definitions require
 * flat top-level `signingDomain` / `selector` / `privateKey`, but the signer
 * ignores those and signs once per `signatureData` entry.
 */
export function mailauthDkimSign(message: Buffer, options: SignatureDataOptions) {
	return dkimSign(message, options as unknown as DKIMSignOptions);
}
