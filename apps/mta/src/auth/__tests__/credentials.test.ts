import { describe, it, expect, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import {
	createCredential,
	lookupCredential,
	revokeCredential,
	listCredentials,
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
