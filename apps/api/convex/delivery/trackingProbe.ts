/**
 * The tracking-domain HTTPS probe, both ends: the route `trackingHttp.ts`
 * serves and the answer `domains/trackingDomainCheck.ts` expects.
 *
 * The checker asks `https://<tracking domain>/t/probe/<nonce>` and expects
 * `HMAC(probe key, nonce)` back. Only a deployment holding the link-signing
 * secret can compute it, so a match proves the request reached THIS
 * deployment's tracking handler through the operator's proxy and certificate,
 * not a parked page, a default vhost or another Owlat instance. A fresh nonce
 * per check keeps a cached answer from passing.
 *
 * The probe key is derived from `UNSUBSCRIBE_SECRET` under its own label and is
 * used for nothing else. Answering arbitrary nonces with the link-signing
 * secret itself would hand anyone a signing oracle for tracked-link and
 * unsubscribe signatures; with the derived key the route answers questions
 * whose answers are worth nothing outside this probe.
 */

import { hmacSignature } from '../lib/crypto';

export const TRACKING_PROBE_PATH_PREFIX = '/t/probe/';

const PROBE_KEY_LABEL = 'owlat tracking-domain probe key v1';

/** A probe nonce: 32 lowercase hex characters, the only input the route answers. */
export function isTrackingProbeNonce(value: string | undefined): value is string {
	return value !== undefined && /^[0-9a-f]{32}$/.test(value);
}

/** The answer this deployment gives, and expects, for `nonce`. */
export async function trackingProbeAnswer(secret: string, nonce: string): Promise<string> {
	const probeKey = await hmacSignature(secret, PROBE_KEY_LABEL, 'sha256', 'hex');
	return await hmacSignature(probeKey, nonce, 'sha256', 'base64url');
}
