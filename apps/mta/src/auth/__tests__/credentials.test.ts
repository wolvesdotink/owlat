import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import {
	createCredential,
	lookupCredential,
	revokeCredential,
	listCredentials,
	listCredentialsWithKeys,
	setAllowedDomains,
} from '../credentials.js';

describe('credentials', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(() => {
		redis = new Redis();
	});

	describe('createCredential', () => {
		it('generates key starting with owlat_', async () => {
			const { apiKey } = await createCredential(redis, 'org-1', 'My Key');
			expect(apiKey.startsWith('owlat_')).toBe(true);
		});
	});

	describe('allowedDomains (H2 verified-sending-domain set)', () => {
		it('normalizes, lowercases and de-duplicates the verified domains on create', async () => {
			const { apiKey } = await createCredential(redis, 'org-1', 'Scoped', [
				'Brand.com',
				' brand.net ',
				'BRAND.COM',
				'',
			]);
			const cred = await lookupCredential(redis, apiKey);
			expect(cred!.allowedDomains).toEqual(['brand.com', 'brand.net']);
		});

		it('leaves allowedDomains undefined when none are supplied (legacy behavior)', async () => {
			const { apiKey } = await createCredential(redis, 'org-1', 'Unscoped');
			const cred = await lookupCredential(redis, apiKey);
			expect(cred!.allowedDomains).toBeUndefined();
		});

		it('records an explicit empty set (fail-closed: authorizes no domain)', async () => {
			const { apiKey } = await createCredential(redis, 'org-1', 'Locked', []);
			const cred = await lookupCredential(redis, apiKey);
			expect(cred!.allowedDomains).toEqual([]);
		});
	});

	describe('setAllowedDomains (H2 backfill primitive)', () => {
		it('normalizes, lowercases and de-duplicates, preserving other fields', async () => {
			const { apiKey } = await createCredential(redis, 'org-1', 'Legacy');
			const before = await lookupCredential(redis, apiKey);
			expect(before!.allowedDomains).toBeUndefined();

			const ok = await setAllowedDomains(redis, apiKey, [
				'Brand.com',
				' brand.net ',
				'BRAND.COM',
				'',
			]);
			expect(ok).toBe(true);

			const after = await lookupCredential(redis, apiKey);
			expect(after!.allowedDomains).toEqual(['brand.com', 'brand.net']);
			// Other fields survive the rewrite.
			expect(after!.organizationId).toBe('org-1');
			expect(after!.name).toBe('Legacy');
			expect(after!.createdAt).toBe(before!.createdAt);
		});

		it('overwrites an existing set (idempotent on re-apply)', async () => {
			const { apiKey } = await createCredential(redis, 'org-1', 'Scoped', ['old.com']);
			await setAllowedDomains(redis, apiKey, ['new.com']);
			const first = await lookupCredential(redis, apiKey);
			expect(first!.allowedDomains).toEqual(['new.com']);
			await setAllowedDomains(redis, apiKey, ['new.com']);
			const second = await lookupCredential(redis, apiKey);
			expect(second!.allowedDomains).toEqual(['new.com']);
		});

		it('returns false for a missing credential', async () => {
			const ok = await setAllowedDomains(redis, 'owlat_missing', ['brand.com']);
			expect(ok).toBe(false);
		});
	});

	describe('listCredentialsWithKeys (full-key admin list)', () => {
		it('returns the FULL api keys (un-truncated) for the org', async () => {
			const { apiKey: keyA } = await createCredential(redis, 'org-full', 'A');
			const { apiKey: keyB } = await createCredential(redis, 'org-full', 'B', ['brand.com']);

			const list = await listCredentialsWithKeys(redis, 'org-full');
			expect(list.length).toBe(2);
			const keys = list.map((c) => c.apiKey).sort();
			expect(keys).toEqual([keyA, keyB].sort());
			for (const c of list) {
				expect(c.apiKey.startsWith('owlat_')).toBe(true);
				expect(c.apiKey).not.toContain('...');
			}
			// The full key round-trips to a working setAllowedDomains PATCH.
			const scoped = list.find((c) => c.credential.name === 'B');
			expect(scoped!.credential.allowedDomains).toEqual(['brand.com']);
		});
	});

	describe('lookupCredential', () => {
		it('returns credential for valid key', async () => {
			const { apiKey } = await createCredential(redis, 'org-1', 'Test Key');

			const cred = await lookupCredential(redis, apiKey);
			expect(cred).not.toBeNull();
			expect(cred!.organizationId).toBe('org-1');
			expect(cred!.name).toBe('Test Key');
		});

		it('returns null for invalid key', async () => {
			const cred = await lookupCredential(redis, 'owlat_invalid');
			expect(cred).toBeNull();
		});
	});

	describe('revokeCredential', () => {
		it('removes credential and returns true', async () => {
			const { apiKey } = await createCredential(redis, 'org-1', 'Revoke Me');

			const revoked = await revokeCredential(redis, apiKey);
			expect(revoked).toBe(true);

			const cred = await lookupCredential(redis, apiKey);
			expect(cred).toBeNull();
		});

		it('returns false for non-existent key', async () => {
			const revoked = await revokeCredential(redis, 'owlat_doesnotexist');
			expect(revoked).toBe(false);
		});
	});

	describe('listCredentials', () => {
		it('returns credentials for the org with truncated keys', async () => {
			await createCredential(redis, 'org-list', 'Key A');
			await createCredential(redis, 'org-list', 'Key B');

			const creds = await listCredentials(redis, 'org-list');
			expect(creds.length).toBe(2);
			// Keys should be truncated
			for (const c of creds) {
				expect(c.apiKey).toContain('...');
			}
		});
	});

	describe('org isolation', () => {
		it('different orgs are isolated', async () => {
			await createCredential(redis, 'org-a', 'Key A');
			await createCredential(redis, 'org-b', 'Key B');

			const credsA = await listCredentials(redis, 'org-a');
			const credsB = await listCredentials(redis, 'org-b');

			expect(credsA.length).toBe(1);
			expect(credsB.length).toBe(1);
			expect(credsA[0]!.credential.organizationId).toBe('org-a');
			expect(credsB[0]!.credential.organizationId).toBe('org-b');
		});
	});
});
