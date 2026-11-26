import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { isKeyRecordError, parseDkimKeyRecord } from '@owlat/mail-auth';
import {
	clearEd25519PublicationCache,
	createEd25519Key,
	describeEd25519Key,
	ed25519DnsRecordFromPrivateKey,
	ed25519PublicationProbesSettled,
	removeEd25519Key,
	resolveOptionalEd25519Key,
} from '../dkimEd25519.js';
import { ED25519_FIELDS, clearCache, getDkimConfig, setDkimKey } from '../dkimStore.js';
import { activatePendingKey, initiateRotation } from '../dkimRotation.js';
import { getMtaSecretBox } from '../../lib/secretBox.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const DOMAIN = 'example.com';
const HASH = `mta:dkim:${DOMAIN}`;
const RSA_PEM = generateKeyPairSync('rsa', {
	modulusLength: 1024,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).privateKey;
const ED_PEM = generateKeyPairSync('ed25519', {
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).privateKey;

/** A TXT resolver that answers `records` for every name and counts its calls. */
function txtAnswering(records: string[][]) {
	return vi.fn(async (_name: string) => records);
}

describe('dkimEd25519', () => {
	let redis: RealRedis;

	beforeEach(async () => {
		redis = new Redis() as unknown as RealRedis;
		await redis.flushall();
		clearCache();
		clearEd25519PublicationCache();
		await setDkimKey(redis, DOMAIN, 's1', RSA_PEM, 'org_a');
	});

	afterEach(async () => {
		await redis.flushall();
		clearCache();
	});

	describe('createEd25519Key', () => {
		it('creates one key and answers the same selector and record on a second call', async () => {
			const first = await createEd25519Key(redis, DOMAIN, 'org_a');
			const second = await createEd25519Key(redis, DOMAIN, 'org_a');

			expect(first).toMatchObject({ kind: 'ok', created: true });
			expect(second).toMatchObject({ kind: 'ok', created: false });
			if (first.kind !== 'ok' || second.kind !== 'ok') return;
			expect(second.selector).toBe(first.selector);
			expect(second.dnsRecord).toBe(first.dnsRecord);
			expect(first.selector).toMatch(/^e\d+$/);
		});

		it('publishes the raw 32-byte key, which the verifier parses as an Ed25519 record', async () => {
			const result = await createEd25519Key(redis, DOMAIN);
			if (result.kind !== 'ok') throw new Error(result.kind);

			const parsed = parseDkimKeyRecord(result.dnsRecord);
			if (isKeyRecordError(parsed)) throw new Error(parsed.reason);
			expect(parsed.keyType).toBe('ed25519');
			const p = /p=([A-Za-z0-9+/=]+)/.exec(result.dnsRecord)![1]!;
			expect(p).toHaveLength(44);
			expect(Buffer.from(p, 'base64')).toHaveLength(32);
		});

		it('seals the private key and marks it as awaiting DNS', async () => {
			await createEd25519Key(redis, DOMAIN);
			const stored = await redis.hgetall(HASH);

			expect(getMtaSecretBox().isSealed(stored[ED25519_FIELDS.privateKey]!)).toBe(true);
			expect(stored[ED25519_FIELDS.awaitingDnsSince]).toBeDefined();
			expect(stored['selector']).toBe('s1');
		});

		it('refuses a domain without an RSA key and writes nothing', async () => {
			expect(await createEd25519Key(redis, 'other.com')).toEqual({ kind: 'no_rsa_key' });
			expect(await redis.exists('mta:dkim:other.com')).toBe(0);
		});

		it('refuses a domain owned by another organization', async () => {
			expect(await createEd25519Key(redis, DOMAIN, 'org_b')).toEqual({ kind: 'org_mismatch' });
			expect(await redis.hget(HASH, ED25519_FIELDS.selector)).toBeNull();
		});
	});

	describe('removeEd25519Key', () => {
		it('removes only the Ed25519 fields and is idempotent', async () => {
			await createEd25519Key(redis, DOMAIN);

			expect(await removeEd25519Key(redis, DOMAIN)).toEqual({ kind: 'ok', removed: true });
			expect(await removeEd25519Key(redis, DOMAIN)).toEqual({ kind: 'ok', removed: false });

			const config = await getDkimConfig(redis, DOMAIN);
			expect(config).toMatchObject({
				selector: 's1',
				privateKey: RSA_PEM,
				organizationId: 'org_a',
			});
			expect(config?.ed25519).toBeUndefined();
			expect(await describeEd25519Key(redis, DOMAIN)).toBeUndefined();
		});
	});

	it('keeps the key of a domain owned by another organization', async () => {
		const created = await createEd25519Key(redis, DOMAIN, 'org_a');
		if (created.kind !== 'ok') throw new Error(created.kind);

		expect(await removeEd25519Key(redis, DOMAIN, 'org_b')).toEqual({ kind: 'org_mismatch' });
		expect((await describeEd25519Key(redis, DOMAIN))?.selector).toBe(created.selector);
		expect(await removeEd25519Key(redis, DOMAIN, 'org_a')).toEqual({ kind: 'ok', removed: true });
	});

	it('describes the key Redis holds, not a cached copy of the domain', async () => {
		// Fill this process's signing cache, then change Redis the way another
		// replica would: without invalidating that cache.
		await getDkimConfig(redis, DOMAIN);
		const sealed = getMtaSecretBox().seal(ED_PEM);
		await redis.hset(HASH, ED25519_FIELDS.selector, 'e9', ED25519_FIELDS.privateKey, sealed);
		expect((await getDkimConfig(redis, DOMAIN))?.ed25519).toBeUndefined();

		expect(await describeEd25519Key(redis, DOMAIN)).toEqual({
			selector: 'e9',
			dnsRecord: ed25519DnsRecordFromPrivateKey(ED_PEM),
		});

		await redis.hdel(HASH, ED25519_FIELDS.selector, ED25519_FIELDS.privateKey);
		expect(await describeEd25519Key(redis, DOMAIN)).toBeUndefined();
	});

	it('an RSA rotation leaves the Ed25519 key alone', async () => {
		const created = await createEd25519Key(redis, DOMAIN);
		if (created.kind !== 'ok') throw new Error(created.kind);

		const pending = await initiateRotation(redis, DOMAIN, { selector: 's2', overlapHours: 0 });
		const activated = await activatePendingKey(
			redis,
			DOMAIN,
			false,
			txtAnswering([[pending.dnsRecord]])
		);

		expect(activated).toMatchObject({ activated: true, selector: 's2' });
		expect((await getDkimConfig(redis, DOMAIN))?.selector).toBe('s2');
		expect(await describeEd25519Key(redis, DOMAIN)).toEqual({
			selector: created.selector,
			dnsRecord: created.dnsRecord,
		});
	});

	describe('resolveOptionalEd25519Key', () => {
		it('answers none for a domain without an Ed25519 key', async () => {
			expect(await resolveOptionalEd25519Key(redis, DOMAIN, 'org_a')).toEqual({ kind: 'none' });
			expect(await resolveOptionalEd25519Key(redis, 'nokey.com', 'org_a')).toEqual({
				kind: 'none',
			});
		});

		it('signs nothing until a background check sees the record, then clears the mark', async () => {
			const created = await createEd25519Key(redis, DOMAIN);
			if (created.kind !== 'ok') throw new Error(created.kind);
			const unpublished = { kind: 'skipped', reason: 'unpublished' };

			const missing = txtAnswering([]);
			expect(await resolveOptionalEd25519Key(redis, DOMAIN, 'org_a', missing)).toEqual(unpublished);
			await ed25519PublicationProbesSettled();
			// The negative cache answers the next message without asking DNS again.
			expect(await resolveOptionalEd25519Key(redis, DOMAIN, 'org_a', missing)).toEqual(unpublished);
			await ed25519PublicationProbesSettled();
			expect(missing).toHaveBeenCalledTimes(1);
			expect(missing).toHaveBeenCalledWith(`${created.selector}._domainkey.${DOMAIN}`);

			// The message that starts the successful check is not held for it.
			clearEd25519PublicationCache();
			const published = txtAnswering([[created.dnsRecord]]);
			expect(await resolveOptionalEd25519Key(redis, DOMAIN, 'org_a', published)).toEqual(
				unpublished
			);
			await ed25519PublicationProbesSettled();
			expect(await redis.hget(HASH, ED25519_FIELDS.awaitingDnsSince)).toBeNull();

			// Once published, the key signs and DNS is not asked again.
			const unused = txtAnswering([]);
			expect(await resolveOptionalEd25519Key(redis, DOMAIN, 'org_a', unused)).toMatchObject({
				kind: 'key',
				key: { domainName: DOMAIN, keySelector: created.selector, algorithm: 'ed25519-sha256' },
			});
			expect(unused).not.toHaveBeenCalled();
		});

		it('does not wait for a resolver that never answers', async () => {
			const created = await createEd25519Key(redis, DOMAIN);
			if (created.kind !== 'ok') throw new Error(created.kind);
			let answer: (records: string[][]) => void = () => {};
			const hanging = vi.fn(() => new Promise<string[][]>((resolve) => void (answer = resolve)));

			expect(await resolveOptionalEd25519Key(redis, DOMAIN, 'org_a', hanging)).toEqual({
				kind: 'skipped',
				reason: 'unpublished',
			});
			// A second message neither waits nor starts a second lookup.
			expect((await resolveOptionalEd25519Key(redis, DOMAIN, 'org_a', hanging)).kind).toBe(
				'skipped'
			);
			expect(hanging).toHaveBeenCalledTimes(1);

			answer([[created.dnsRecord]]);
			await ed25519PublicationProbesSettled();
			expect((await resolveOptionalEd25519Key(redis, DOMAIN, 'org_a')).kind).toBe('key');
		});

		it.each([
			['without a key type, which reads as RSA', (p: string) => `v=DKIM1; p=${p}`],
			['with the RSA key type', (p: string) => `v=DKIM1; k=rsa; p=${p}`],
			['with another key', () => ed25519DnsRecordFromPrivateKey(ED_PEM)],
			['whose hash list leaves out SHA-256', (p: string) => `v=DKIM1; k=ed25519; h=sha1; p=${p}`],
			['whose service type leaves out email', (p: string) => `v=DKIM1; k=ed25519; s=other; p=${p}`],
		])('keeps the mark for a record %s', async (_case, recordFor) => {
			const created = await createEd25519Key(redis, DOMAIN);
			if (created.kind !== 'ok') throw new Error(created.kind);
			const p = /p=([A-Za-z0-9+/=]+)/.exec(created.dnsRecord)![1]!;

			await resolveOptionalEd25519Key(redis, DOMAIN, 'org_a', txtAnswering([[recordFor(p)]]));
			await ed25519PublicationProbesSettled();

			expect(await redis.hget(HASH, ED25519_FIELDS.awaitingDnsSince)).not.toBeNull();
		});

		it('accepts the record split into TXT chunks with spaces', async () => {
			const created = await createEd25519Key(redis, DOMAIN);
			if (created.kind !== 'ok') throw new Error(created.kind);
			const p = /p=([A-Za-z0-9+/=]+)/.exec(created.dnsRecord)![1]!;

			await resolveOptionalEd25519Key(
				redis,
				DOMAIN,
				'org_a',
				txtAnswering([['v=DKIM1;k=ed25519; ', `p=${p.slice(0, 20)}`, p.slice(20)]])
			);
			await ed25519PublicationProbesSettled();

			expect(await redis.hget(HASH, ED25519_FIELDS.awaitingDnsSince)).toBeNull();
		});

		it('skips a key that does not open', async () => {
			await createEd25519Key(redis, DOMAIN);
			await redis.hset(HASH, { [ED25519_FIELDS.privateKey]: 'mtasealed:v1:garbage' });
			await redis.hdel(HASH, ED25519_FIELDS.awaitingDnsSince);
			clearCache();

			expect(await resolveOptionalEd25519Key(redis, DOMAIN, 'org_a')).toEqual({
				kind: 'skipped',
				reason: 'unreadable',
			});
			// The RSA key still opens.
			expect((await getDkimConfig(redis, DOMAIN))?.privateKey).toBe(RSA_PEM);
		});

		it('skips a stored key that is not Ed25519', async () => {
			await redis.hset(HASH, {
				[ED25519_FIELDS.selector]: 'e1',
				[ED25519_FIELDS.privateKey]: getMtaSecretBox().seal(RSA_PEM),
			});
			clearCache();

			expect(await resolveOptionalEd25519Key(redis, DOMAIN, 'org_a')).toEqual({
				kind: 'skipped',
				reason: 'unusable',
			});
		});

		it('skips the key for a job from another organization', async () => {
			await createEd25519Key(redis, DOMAIN);
			await redis.hdel(HASH, ED25519_FIELDS.awaitingDnsSince);
			clearCache();

			expect(await resolveOptionalEd25519Key(redis, DOMAIN, 'org_b')).toEqual({
				kind: 'skipped',
				reason: 'org_mismatch',
			});
			expect((await resolveOptionalEd25519Key(redis, DOMAIN, 'postbox')).kind).toBe('key');
		});
	});

	it('derives the record from the private key and refuses an RSA key', () => {
		const ed = generateKeyPairSync('ed25519', {
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
			publicKeyEncoding: { type: 'spki', format: 'der' },
		});
		expect(ed25519DnsRecordFromPrivateKey(ed.privateKey)).toBe(
			`v=DKIM1; k=ed25519; p=${ed.publicKey.subarray(12).toString('base64')}`
		);
		expect(() => ed25519DnsRecordFromPrivateKey(RSA_PEM)).toThrow();
	});
});
