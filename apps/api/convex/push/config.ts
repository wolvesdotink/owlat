/**
 * Whether this deployment can send Web Push, and with which identity.
 *
 * Both halves of the VAPID pair must be set (lib/env.ts `VAPID_*`); with
 * either missing the whole feature reads as off: the Preferences card hides,
 * producers schedule nothing and a stale subscription is never pushed to.
 */

import { getOptional } from '../lib/env';
import type { VapidKeys } from '../lib/webPush';

/** The public key alone, for the browser's `applicationServerKey`; null when push is off. */
export function vapidPublicKey(): string | null {
	const publicKey = getOptional('VAPID_PUBLIC_KEY');
	const privateKey = getOptional('VAPID_PRIVATE_KEY');
	return publicKey && privateKey ? publicKey : null;
}

/** True when Web Push is configured on this deployment. */
export function isWebPushConfigured(): boolean {
	return vapidPublicKey() !== null;
}

/**
 * The full signing identity, or null when push is off. The subject falls back
 * to the site URL: push services want a way to reach the operator, and the
 * instance's own address is the one every deployment has.
 */
export function readVapidKeys(): VapidKeys | null {
	const publicKey = getOptional('VAPID_PUBLIC_KEY');
	const privateKey = getOptional('VAPID_PRIVATE_KEY');
	if (!publicKey || !privateKey) return null;
	const subject =
		getOptional('VAPID_SUBJECT') || getOptional('SITE_URL') || 'mailto:postmaster@localhost';
	return { publicKey, privateKey, subject };
}
