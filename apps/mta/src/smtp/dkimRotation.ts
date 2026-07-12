/**
 * DKIM Key Rotation Workflow
 *
 * Provides automated DKIM key rotation with a safe overlap period:
 * 1. Generate new key pair with new selector
 * 2. Store new key but continue signing with old key (overlap period)
 * 3. After DNS propagation delay, switch signing to new key
 * 4. Old key remains in DNS for verification of in-flight messages
 *
 * Rotation state is tracked in Redis per domain.
 */

import { generateKeyPairSync } from 'crypto';
import { resolveTxt } from 'dns/promises';
import type Redis from 'ioredis';
import { getDkimConfig, setDkimKey, listDkimDomains } from './dkimStore.js';
import { getMtaSecretBox } from '../lib/secretBox.js';
import { logger } from '../monitoring/logger.js';

/** Injectable for tests; matches dns/promises resolveTxt. */
export type TxtResolver = (hostname: string) => Promise<string[][]>;

/**
 * MTA→Convex DKIM rotation callback. Convex stores the customer-facing
 * `dnsRecords` once at registration and has no other way to learn the rotated
 * selector, so the rotation caller must push the new selector + record back so
 * the customer sees it and `verifyDomain` checks the right host (RFC 6376
 * §3.6.1).
 *
 *   - `'pending'`   — rotation initiated: publish the new selector's record
 *                     alongside the active one (overlap).
 *   - `'activated'` — signing switched to the new key: retire the old selector.
 *
 * Injectable so callers wire it to `notifyConvex` and tests can capture the
 * propagated payload. Defaults to a no-op so existing callers are unaffected.
 */
export type DkimRotationNotifier = (rotation: {
	domain: string;
	selector: string;
	dnsRecord: string;
	phase: 'pending' | 'activated';
}) => Promise<void>;

const noopNotifier: DkimRotationNotifier = async () => {};

/**
 * True when the pending selector's DKIM TXT record is published in DNS and
 * carries the expected public key. Activation is gated on this so we never
 * switch signing to a key whose public record isn't live yet — that would fail
 * DKIM on ALL outbound mail. Any lookup error is treated as "not published",
 * the safe direction (the cron simply retries on its next pass).
 */
export async function isPendingDnsPublished(
	domain: string,
	selector: string,
	expectedDnsRecord: string | undefined,
	resolveTxtFn: TxtResolver = resolveTxt
): Promise<boolean> {
	if (!expectedDnsRecord) return false;
	const expectedP = /p=([A-Za-z0-9+/=]+)/.exec(expectedDnsRecord)?.[1];
	if (!expectedP) return false;
	try {
		const records = await resolveTxtFn(`${selector}._domainkey.${domain}`);
		// Each record is an array of TXT chunks; join them and strip whitespace.
		return records.some((chunks) => chunks.join('').replace(/\s/g, '').includes(`p=${expectedP}`));
	} catch {
		return false;
	}
}

const ROTATION_PREFIX = 'mta:dkim:rotation:';
const DEFAULT_ROTATION_INTERVAL_DAYS = 180; // 6 months
const DEFAULT_OVERLAP_HOURS = 48; // 48h overlap for DNS propagation

export interface RotationState {
	/** Domain being rotated */
	domain: string;
	/** Current active selector */
	activeSelector: string;
	/** New selector pending activation */
	pendingSelector?: string;
	/** DNS TXT record value for the pending key */
	pendingDnsRecord?: string;
	/** When the pending key was generated */
	pendingCreatedAt?: number;
	/** When the pending key should be activated (after DNS propagation) */
	activateAfter?: number;
	/** When the current key was last rotated */
	lastRotatedAt: number;
	/** When the next rotation is recommended */
	nextRotationAt: number;
}

/**
 * Initiate a DKIM key rotation for a domain.
 *
 * This generates a new key pair but does NOT immediately activate it.
 * The caller must:
 * 1. Publish the returned DNS record to the new selector
 * 2. Wait for DNS propagation (default 48h)
 * 3. Call `activatePendingKey()` to switch signing to the new key
 *
 * @returns The new selector and DNS TXT record to publish
 */
export async function initiateRotation(
	redis: Redis,
	domain: string,
	options?: {
		selector?: string;
		keySize?: number;
		overlapHours?: number;
		/**
		 * Pushes the new selector + record back to Convex so the customer sees
		 * the record and `verifyDomain` checks it during the overlap. Defaults
		 * to a no-op.
		 */
		notify?: DkimRotationNotifier;
	}
): Promise<{ selector: string; dnsRecord: string; activateAfter: Date }> {
	const keySize = options?.keySize ?? 2048;
	const overlapHours = options?.overlapHours ?? DEFAULT_OVERLAP_HOURS;

	// Check for existing pending rotation
	const existing = await getRotationState(redis, domain);
	if (existing?.pendingSelector) {
		throw new Error(
			`Domain ${domain} already has a pending rotation (selector: ${existing.pendingSelector}). Activate or cancel it first.`
		);
	}

	// Get current active key
	const currentConfig = await getDkimConfig(redis, domain);
	if (!currentConfig) {
		throw new Error(`No DKIM key configured for domain ${domain}`);
	}

	// Generate new key pair
	const newSelector = options?.selector ?? `s${Date.now()}`;

	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: keySize,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});

	// Format public key for DNS TXT record
	const pubKeyBase64 = publicKey
		.replace('-----BEGIN PUBLIC KEY-----', '')
		.replace('-----END PUBLIC KEY-----', '')
		.replace(/\s/g, '');
	const dnsRecord = `v=DKIM1; k=rsa; p=${pubKeyBase64}`;

	// Store the pending key in Redis (separate from the active key). The private
	// key is sealed at rest (secretBox) so a Redis dump taken during the multi-day
	// rotation overlap window never exposes the about-to-be-active PEM — the same
	// at-rest guarantee active keys get in dkimStore. activatePendingKey unseals
	// on read, so the promoted key is byte-identical to what was generated here.
	const pendingKeyRedis = `mta:dkim:pending:${domain}`;
	await redis.hset(pendingKeyRedis, {
		selector: newSelector,
		privateKey: getMtaSecretBox().seal(privateKey),
	});
	await redis.expire(pendingKeyRedis, 30 * 86400); // 30 day expiry

	// Update rotation state
	const activateAfter = Date.now() + overlapHours * 60 * 60 * 1000;
	const rotationState: Record<string, string> = {
		activeSelector: currentConfig.selector,
		pendingSelector: newSelector,
		pendingDnsRecord: dnsRecord,
		pendingCreatedAt: String(Date.now()),
		activateAfter: String(activateAfter),
		lastRotatedAt: String(existing?.lastRotatedAt ?? Date.now()),
		nextRotationAt: String(Date.now() + DEFAULT_ROTATION_INTERVAL_DAYS * 86400_000),
	};

	await redis.hset(`${ROTATION_PREFIX}${domain}`, rotationState);

	logger.info(
		{ domain, newSelector, activateAfter: new Date(activateAfter).toISOString() },
		'DKIM rotation initiated — publish DNS record and wait for propagation'
	);

	// Propagate the new selector + record to Convex so the customer sees it and
	// `verifyDomain` checks it during the overlap (alongside the active key).
	const notify = options?.notify ?? noopNotifier;
	await notify({ domain, selector: newSelector, dnsRecord, phase: 'pending' });

	return {
		selector: newSelector,
		dnsRecord,
		activateAfter: new Date(activateAfter),
	};
}

/**
 * Activate a pending DKIM key after DNS propagation.
 *
 * This switches the active signing key to the pending key and
 * removes the pending state.
 */
export async function activatePendingKey(
	redis: Redis,
	domain: string,
	force = false,
	resolveTxtFn: TxtResolver = resolveTxt,
	notify: DkimRotationNotifier = noopNotifier
): Promise<{ activated: boolean; selector?: string }> {
	const state = await getRotationState(redis, domain);
	if (!state?.pendingSelector) {
		return { activated: false };
	}

	// Check if overlap period has passed
	if (!force && state.activateAfter && Date.now() < state.activateAfter) {
		const remainingMs = state.activateAfter - Date.now();
		const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1000));
		logger.info(
			{ domain, remainingHours },
			'Pending key not yet ready for activation — overlap period not elapsed'
		);
		return { activated: false };
	}

	// Verify the new key's DNS record is actually published before switching to
	// it — activating a key whose public record isn't live would break DKIM for
	// all outbound mail. `force` (a manual operator override) skips the check.
	if (!force) {
		const published = await isPendingDnsPublished(
			domain,
			state.pendingSelector,
			state.pendingDnsRecord,
			resolveTxtFn
		);
		if (!published) {
			logger.warn(
				{ domain, selector: state.pendingSelector },
				'Pending DKIM key not activated — its DNS TXT record is not published yet; publish it and it activates on the next check'
			);
			return { activated: false };
		}
	}

	// Load the pending key
	const pendingKeyRedis = `mta:dkim:pending:${domain}`;
	const pendingData = await redis.hgetall(pendingKeyRedis);
	if (!pendingData['selector'] || !pendingData['privateKey']) {
		logger.error({ domain }, 'Pending key data not found in Redis');
		return { activated: false };
	}

	// Unseal the pending private key (sealed on write in initiateRotation),
	// tolerating a legacy plaintext value written by an older MTA before pending
	// keys were sealed. setDkimKey re-seals it under the active hash.
	const box = getMtaSecretBox();
	const pendingPrivateKey = box.isSealed(pendingData['privateKey'])
		? box.open(pendingData['privateKey'])
		: pendingData['privateKey'];

	// Activate: set the pending key as the new active key
	await setDkimKey(redis, domain, pendingData['selector'], pendingPrivateKey);

	// Clean up pending state
	await redis.del(pendingKeyRedis);
	await redis.hset(`${ROTATION_PREFIX}${domain}`, {
		activeSelector: pendingData['selector'],
		lastRotatedAt: String(Date.now()),
		nextRotationAt: String(Date.now() + DEFAULT_ROTATION_INTERVAL_DAYS * 86400_000),
	});
	await redis.hdel(
		`${ROTATION_PREFIX}${domain}`,
		'pendingSelector',
		'pendingDnsRecord',
		'pendingCreatedAt',
		'activateAfter'
	);

	logger.info({ domain, selector: pendingData['selector'] }, 'DKIM key rotation activated');

	// Propagate the activated selector to Convex so the old selector is retired
	// from `dnsRecords` and `verifyDomain` stops checking it (RFC 6376 §3.6.1).
	// The pending record value is carried in the rotation state we just read.
	if (state.pendingDnsRecord) {
		await notify({
			domain,
			selector: pendingData['selector'],
			dnsRecord: state.pendingDnsRecord,
			phase: 'activated',
		});
	}

	return { activated: true, selector: pendingData['selector'] };
}

/**
 * Cancel a pending DKIM key rotation
 */
export async function cancelRotation(redis: Redis, domain: string): Promise<boolean> {
	const state = await getRotationState(redis, domain);
	if (!state?.pendingSelector) {
		return false;
	}

	await redis.del(`mta:dkim:pending:${domain}`);
	await redis.hdel(
		`${ROTATION_PREFIX}${domain}`,
		'pendingSelector',
		'pendingDnsRecord',
		'pendingCreatedAt',
		'activateAfter'
	);

	logger.info({ domain }, 'DKIM key rotation cancelled');
	return true;
}

/**
 * Get the rotation state for a domain
 */
export async function getRotationState(
	redis: Redis,
	domain: string
): Promise<RotationState | null> {
	const data = await redis.hgetall(`${ROTATION_PREFIX}${domain}`);
	if (!data['activeSelector']) return null;

	return {
		domain,
		activeSelector: data['activeSelector'],
		pendingSelector: data['pendingSelector'] || undefined,
		pendingDnsRecord: data['pendingDnsRecord'] || undefined,
		pendingCreatedAt: data['pendingCreatedAt'] ? parseInt(data['pendingCreatedAt'], 10) : undefined,
		activateAfter: data['activateAfter'] ? parseInt(data['activateAfter'], 10) : undefined,
		lastRotatedAt: parseInt(data['lastRotatedAt'] || '0', 10),
		nextRotationAt: parseInt(data['nextRotationAt'] || '0', 10),
	};
}

/**
 * Check all domains for keys due for rotation.
 * Called periodically by the leader instance.
 *
 * Returns domains that need attention (past rotation date or have pending keys ready).
 */
export async function checkRotationStatus(redis: Redis): Promise<
	Array<{
		domain: string;
		action: 'needs_rotation' | 'pending_ready' | 'pending_waiting';
		details: string;
	}>
> {
	const domains = await listDkimDomains(redis);
	const results: Array<{
		domain: string;
		action: 'needs_rotation' | 'pending_ready' | 'pending_waiting';
		details: string;
	}> = [];

	for (const { domain } of domains) {
		const state = await getRotationState(redis, domain);

		if (state?.pendingSelector) {
			// Has pending key
			if (state.activateAfter && Date.now() >= state.activateAfter) {
				results.push({
					domain,
					action: 'pending_ready',
					details: `Pending selector ${state.pendingSelector} ready for activation`,
				});
			} else {
				const remainingMs = (state.activateAfter ?? 0) - Date.now();
				const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1000));
				results.push({
					domain,
					action: 'pending_waiting',
					details: `Pending selector ${state.pendingSelector} — ${remainingHours}h until activation`,
				});
			}
		} else if (state && Date.now() >= state.nextRotationAt) {
			results.push({
				domain,
				action: 'needs_rotation',
				details: `Key last rotated ${Math.round((Date.now() - state.lastRotatedAt) / 86400_000)} days ago`,
			});
		}
	}

	return results;
}
