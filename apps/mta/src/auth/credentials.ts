/**
 * Per-Organization Credential Management
 *
 * Credentials are stored in Redis and provide per-org API key isolation.
 * The master key (MTA_API_KEY) remains for Convex backend access.
 */

import { randomBytes } from 'crypto';
import type Redis from 'ioredis';
import { fireAndForget } from '../lib/fireAndForget.js';
import { logger } from '../monitoring/logger.js';

export interface OrgCredential {
	organizationId: string;
	name: string;
	/**
	 * The organization's verified sending domains (lowercased). When present,
	 * submission enforces that a message's From domain is in this set — the H2
	 * cross-tenant From-forgery guard, mirroring the Postbox mailbox guard. Absent
	 * on legacy credentials created before this field existed: those stay unscoped
	 * at submission until re-provisioned, and the org-scoped DKIM signer is the
	 * fail-closed backstop that still blocks signing under another tenant's key.
	 */
	allowedDomains?: string[];
	createdAt: number;
	lastUsedAt?: number;
}

/** Normalize a verified-domain list: lowercased, trimmed, de-duplicated, no blanks. */
function normalizeAllowedDomains(domains: readonly string[]): string[] {
	return [
		...new Set(
			domains.map((domain) => domain.trim().toLowerCase()).filter((domain) => domain.length > 0)
		),
	];
}

const CRED_PREFIX = 'mta:cred:';
const CRED_INDEX_PREFIX = 'mta:cred-index:'; // org → set of key IDs

/**
 * Generate a new API key for an organization
 */
export async function createCredential(
	redis: Redis,
	organizationId: string,
	name: string,
	allowedDomains?: readonly string[]
): Promise<{ apiKey: string; credential: OrgCredential }> {
	const apiKey = `owlat_${randomBytes(16).toString('hex')}`;
	const credential: OrgCredential = {
		organizationId,
		name,
		createdAt: Date.now(),
		...(allowedDomains ? { allowedDomains: normalizeAllowedDomains(allowedDomains) } : {}),
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
		void fireAndForget(
			redis.set(`${CRED_PREFIX}${apiKey}`, JSON.stringify(credential)),
			logger,
			'credential_last_used'
		);
		return credential;
	} catch {
		return null;
	}
}

/**
 * Overwrite a credential's `allowedDomains` (the H2 verified-sending-domain set),
 * preserving every other field on the blob. The list is normalized (lowercased,
 * trimmed, de-duplicated, no blanks) exactly as {@link createCredential} does, so
 * the two write paths can never disagree on the stored shape.
 *
 * Idempotent: re-writing the same normalized set leaves the blob byte-identical.
 * Returns `false` when no credential exists for `apiKey` (so the route can 404),
 * or when the stored blob is unparseable.
 */
export async function setAllowedDomains(
	redis: Redis,
	apiKey: string,
	domains: readonly string[]
): Promise<boolean> {
	const data = await redis.get(`${CRED_PREFIX}${apiKey}`);
	if (!data) return false;

	let credential: OrgCredential;
	try {
		credential = JSON.parse(data) as OrgCredential;
	} catch {
		return false;
	}

	const updated: OrgCredential = {
		...credential,
		allowedDomains: normalizeAllowedDomains(domains),
	};
	await redis.set(`${CRED_PREFIX}${apiKey}`, JSON.stringify(updated));
	return true;
}

/**
 * List an organization's credentials WITH their full API keys (master-key admin
 * paths only — e.g. the allowedDomains backfill migration, which must address a
 * PATCH by the full key). This is the un-truncated sibling of
 * {@link listCredentials}: that one redacts the key for any surface that might
 * reach an operator, this one is for server-to-server use behind the master key.
 */
export async function listCredentialsWithKeys(
	redis: Redis,
	organizationId: string
): Promise<Array<{ apiKey: string; credential: OrgCredential }>> {
	const keys = await redis.smembers(`${CRED_INDEX_PREFIX}${organizationId}`);
	const results: Array<{ apiKey: string; credential: OrgCredential }> = [];

	for (const key of keys) {
		const data = await redis.get(`${CRED_PREFIX}${key}`);
		if (data) {
			try {
				results.push({ apiKey: key, credential: JSON.parse(data) as OrgCredential });
			} catch {
				// Skip invalid entries
			}
		}
	}

	return results;
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
		const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${CRED_PREFIX}*`, 'COUNT', 100);
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
