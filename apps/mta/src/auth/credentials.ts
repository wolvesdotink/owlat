/**
 * Per-Organization Credential Management
 *
 * Credentials are stored in Redis and provide per-org API key isolation.
 * The master key (MTA_API_KEY) remains for Convex backend access.
 */

import { randomBytes } from 'crypto';
import type Redis from 'ioredis';

export interface OrgCredential {
	organizationId: string;
	name: string;
	createdAt: number;
	lastUsedAt?: number;
}

const CRED_PREFIX = 'mta:cred:';
const CRED_INDEX_PREFIX = 'mta:cred-index:'; // org → set of key IDs

/**
 * Generate a new API key for an organization
 */
export async function createCredential(
	redis: Redis,
	organizationId: string,
	name: string
): Promise<{ apiKey: string; credential: OrgCredential }> {
	const apiKey = `owlat_${randomBytes(16).toString('hex')}`;
	const credential: OrgCredential = {
		organizationId,
		name,
		createdAt: Date.now(),
	};

	await redis.set(`${CRED_PREFIX}${apiKey}`, JSON.stringify(credential));
	await redis.sadd(`${CRED_INDEX_PREFIX}${organizationId}`, apiKey);

	return { apiKey, credential };
}

/**
 * Look up a credential by API key
 * Returns null if not found (caller should fall back to master key check)
 */
export async function lookupCredential(
	redis: Redis,
	apiKey: string
): Promise<OrgCredential | null> {
	const data = await redis.get(`${CRED_PREFIX}${apiKey}`);
	if (!data) return null;

	try {
		const credential = JSON.parse(data) as OrgCredential;
		// Update lastUsedAt (fire-and-forget)
		credential.lastUsedAt = Date.now();
		redis.set(`${CRED_PREFIX}${apiKey}`, JSON.stringify(credential)).catch(() => {});
		return credential;
	} catch {
		return null;
	}
}

/**
 * Revoke a credential
 */
export async function revokeCredential(redis: Redis, apiKey: string): Promise<boolean> {
	const data = await redis.get(`${CRED_PREFIX}${apiKey}`);
	if (!data) return false;

	try {
		const credential = JSON.parse(data) as OrgCredential;
		await redis.del(`${CRED_PREFIX}${apiKey}`);
		await redis.srem(`${CRED_INDEX_PREFIX}${credential.organizationId}`, apiKey);
		return true;
	} catch {
		return false;
	}
}

/**
 * List all credentials for an organization
 */
export async function listCredentials(
	redis: Redis,
	organizationId: string
): Promise<Array<{ apiKey: string; credential: OrgCredential }>> {
	const keys = await redis.smembers(`${CRED_INDEX_PREFIX}${organizationId}`);
	const results: Array<{ apiKey: string; credential: OrgCredential }> = [];

	for (const key of keys) {
		const data = await redis.get(`${CRED_PREFIX}${key}`);
		if (data) {
			try {
				results.push({ apiKey: `${key.slice(0, 10)}...`, credential: JSON.parse(data) });
			} catch {
				// Skip invalid entries
			}
		}
	}

	return results;
}

/**
 * List ALL credentials (master key only, for admin)
 */
export async function listAllCredentials(
	redis: Redis
): Promise<Array<{ apiKeyPrefix: string; credential: OrgCredential }>> {
	const results: Array<{ apiKeyPrefix: string; credential: OrgCredential }> = [];
	let cursor = '0';

	do {
		const [nextCursor, keys] = await redis.scan(
			cursor,
			'MATCH',
			`${CRED_PREFIX}*`,
			'COUNT',
			100
		);
		cursor = nextCursor;

		for (const key of keys) {
			const data = await redis.get(key);
			if (data) {
				try {
					const apiKey = key.replace(CRED_PREFIX, '');
					results.push({
						apiKeyPrefix: `${apiKey.slice(0, 10)}...`,
						credential: JSON.parse(data),
					});
				} catch {
					// Skip invalid
				}
			}
		}
	} while (cursor !== '0');

	return results;
}
