import { describe, it, expect, beforeEach, vi } from 'vitest';
import Redis from 'ioredis-mock';
import { generateKeyPairSync } from 'crypto';
import { clearDkimPublicationCache, getDkimOptions, resolveRequiredDkimKey } from '../dkim.js';
import {
	setDkimKey,
	clearCache,
	dnsRecordFromPrivateKey,
	getDkimConfig,
	registerDomainKey,
} from '../dkimStore.js';
import { resetMtaSecretBoxForTests } from '../../lib/secretBox.js';

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

/**
 * A send Convex marks as owed a signature gets a key only when that key would
 * produce a signature receivers can verify; anything else names its cause.
 */
describe('resolveRequiredDkimKey', () => {
	let redis: InstanceType<typeof Redis>;
	const pem = () =>
		generateKeyPairSync('rsa', {
			modulusLength: 1024,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		}).privateKey;

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
		clearCache();
		clearDkimPublicationCache();
	});

	it('names no_key when nothing is stored', async () => {
		expect(await resolveRequiredDkimKey(redis, 'brand.com', 'org-a')).toEqual({
			kind: 'unavailable',
			cause: 'no_key',
		});
	});

	it('names org_mismatch for another tenant’s key', async () => {
		await setDkimKey(redis, 'brand.com', 's1', pem(), 'org-a');
		expect(await resolveRequiredDkimKey(redis, 'brand.com', 'org-b')).toEqual({
			kind: 'unavailable',
			cause: 'org_mismatch',
		});
	});

	it('names unusable for a PEM that does not parse', async () => {
		await setDkimKey(redis, 'brand.com', 's1', 'pk', 'org-a');
		expect(await resolveRequiredDkimKey(redis, 'brand.com', 'org-a')).toEqual({
			kind: 'unavailable',
			cause: 'unusable',
		});
	});

	it('names unreadable when the key was sealed under another MTA_SECRET', async () => {
		await setDkimKey(redis, 'brand.com', 's1', pem(), 'org-a');
		clearCache();
		const original = process.env['MTA_SECRET'];
		process.env['MTA_SECRET'] = 'another-mta-secret-0123456789abcdef0123456789abcdef';
		resetMtaSecretBoxForTests();
		try {
			expect(await resolveRequiredDkimKey(redis, 'brand.com', 'org-a')).toEqual({
				kind: 'unavailable',
				cause: 'unreadable',
			});
		} finally {
			process.env['MTA_SECRET'] = original;
			resetMtaSecretBoxForTests();
		}
	});

	it('returns an operator-supplied key without asking DNS', async () => {
		const privateKey = pem();
		await setDkimKey(redis, 'brand.com', 's1', privateKey, 'org-a');
		const resolveTxt = vi.fn();
		expect(await resolveRequiredDkimKey(redis, 'brand.com', 'org-a', resolveTxt)).toEqual({
			kind: 'key',
			key: { domainName: 'brand.com', keySelector: 's1', privateKey },
		});
		expect(resolveTxt).not.toHaveBeenCalled();
	});

	it('holds a key the MTA generated until its record is published, then marks it once', async () => {
		const { selector, dnsRecord } = await registerDomainKey(redis, 'brand.com', 'org-a');
		const unpublished = vi
			.fn()
			.mockRejectedValue(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }));
		expect(await resolveRequiredDkimKey(redis, 'brand.com', 'org-a', unpublished)).toEqual({
			kind: 'unavailable',
			cause: 'unpublished',
		});
		expect(unpublished).toHaveBeenCalledWith(`${selector}._domainkey.brand.com`);
		// System mail never waits for DNS: it is signed with the key already, and
		// a receiver that cannot find the record treats the mail as unsigned.
		expect((await getDkimOptions(redis, 'brand.com', 'system'))?.keySelector).toBe(selector);

		clearDkimPublicationCache();
		const published = vi.fn().mockResolvedValue([[dnsRecord]]);
		const resolved = await resolveRequiredDkimKey(redis, 'brand.com', 'org-a', published);
		expect(resolved.kind).toBe('key');
		expect((await getDkimConfig(redis, 'brand.com'))?.awaitingDnsSince).toBeUndefined();

		const again = vi.fn();
		expect((await resolveRequiredDkimKey(redis, 'brand.com', 'org-a', again)).kind).toBe('key');
		expect(again).not.toHaveBeenCalled();
	});

	it('does not accept the record of the key it replaced', async () => {
		const old = pem();
		await registerDomainKey(redis, 'brand.com', 'org-a');
		const stale = vi.fn().mockResolvedValue([[dnsRecordFromPrivateKey(old)]]);
		expect((await resolveRequiredDkimKey(redis, 'brand.com', 'org-a', stale)).kind).toBe(
			'unavailable'
		);
	});
});
