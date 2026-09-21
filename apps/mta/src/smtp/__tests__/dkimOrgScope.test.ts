import { describe, it, expect, beforeEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import { getDkimOptions } from '../dkim.js';
import { setDkimKey, clearCache } from '../dkimStore.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * H2 cross-tenant DKIM guard: a domain key bound to one organization may only
 * sign for jobs from that organization. A different tenant is refused the key
 * (ships unsigned) rather than being handed another tenant's DKIM identity.
 */
describe('getDkimOptions organization scoping (H2)', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(() => {
		redis = new Redis();
		clearCache();
	});

	it('returns the key when the job organization owns the domain', async () => {
		await setDkimKey(redis, 'brand.com', 's1', 'pk', 'org-a');
		clearCache();
		const options = await getDkimOptions(redis, 'brand.com', 'org-a');
		expect(options).toBeDefined();
		expect(options!.domainName).toBe('brand.com');
		expect(options!.privateKey).toBe('pk');
	});

	it('refuses the key when a DIFFERENT organization requests it (no cross-tenant signing)', async () => {
		await setDkimKey(redis, 'brand.com', 's1', 'pk', 'org-a');
		clearCache();
		const options = await getDkimOptions(redis, 'brand.com', 'org-b');
		expect(options).toBeUndefined();
	});

	it('allows a legacy unowned key to sign for any organization (backward compatible)', async () => {
		await setDkimKey(redis, 'legacy.com', 's1', 'pk'); // no owner recorded
		clearCache();
		const options = await getDkimOptions(redis, 'legacy.com', 'org-b');
		expect(options).toBeDefined();
		expect(options!.privateKey).toBe('pk');
	});

	it('matches ownership case-insensitively on the domain', async () => {
		await setDkimKey(redis, 'brand.com', 's1', 'pk', 'org-a');
		clearCache();
		const options = await getDkimOptions(redis, 'Brand.COM', 'org-a');
		expect(options).toBeDefined();
	});

	it('signs a postbox-sentinel job with an org-owned key (in-app Postbox path stays signed)', async () => {
		// A domain re-registered with its real owning org must still sign the
		// personal mail dispatched as the master-key-only 'postbox' sentinel.
		await setDkimKey(redis, 'brand.com', 's1', 'pk', 'org-a');
		clearCache();
		const options = await getDkimOptions(redis, 'brand.com', 'postbox');
		expect(options).toBeDefined();
		expect(options!.privateKey).toBe('pk');
	});

	it('signs a system-sentinel job with an org-owned key', async () => {
		await setDkimKey(redis, 'brand.com', 's1', 'pk', 'org-a');
		clearCache();
		const options = await getDkimOptions(redis, 'brand.com', 'system');
		expect(options).toBeDefined();
		expect(options!.privateKey).toBe('pk');
	});

	it('still refuses a real per-org tenant job for a domain owned by another org', async () => {
		// The sentinel exemption must not weaken the cross-tenant guard for
		// genuine tenant org ids.
		await setDkimKey(redis, 'brand.com', 's1', 'pk', 'org-a');
		clearCache();
		const options = await getDkimOptions(redis, 'brand.com', 'org-b');
		expect(options).toBeUndefined();
	});
});
