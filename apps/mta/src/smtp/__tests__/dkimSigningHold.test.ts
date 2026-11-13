import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { dkimSignatureWithheldTotal } = await import('../../monitoring/collector.js');
const {
	DKIM_HOLD_REPORT_WINDOW_MS,
	clearDkimSigningHold,
	readDkimSigningHolds,
	recordDkimSigningHold,
} = await import('../dkimSigningHold.js');
const { setDkimKey } = await import('../dkimStore.js');

describe('DKIM signing holds', () => {
	let redis: InstanceType<typeof Redis>;
	const now = Date.UTC(2026, 10, 13);

	beforeEach(async () => {
		redis = new Redis();
		await redis.flushall();
		dkimSignatureWithheldTotal.reset();
	});

	it('counts each held send by cause and keeps the first time the domain was held', async () => {
		await recordDkimSigningHold(redis, 'brand.example', 'no_key', now);
		await recordDkimSigningHold(redis, 'brand.example', 'unpublished', now + 60_000);

		expect(await readDkimSigningHolds(redis, now + 60_000)).toEqual([
			{ domain: 'brand.example', cause: 'unpublished', since: now },
		]);
		const metric = await dkimSignatureWithheldTotal.get();
		expect(metric.values.map((v) => [v.labels['cause'], v.value])).toEqual([
			['no_key', 1],
			['unpublished', 1],
		]);
	});

	it('stops reporting a hold nothing has refreshed within the window', async () => {
		await recordDkimSigningHold(redis, 'brand.example', 'no_key', now);

		expect(await readDkimSigningHolds(redis, now + DKIM_HOLD_REPORT_WINDOW_MS)).toEqual([]);
	});

	it('starts a new streak after a lapse', async () => {
		await recordDkimSigningHold(redis, 'brand.example', 'no_key', now);
		const later = now + DKIM_HOLD_REPORT_WINDOW_MS + 1;
		await recordDkimSigningHold(redis, 'brand.example', 'no_key', later);

		expect((await readDkimSigningHolds(redis, later))[0]?.since).toBe(later);
	});

	it('stops reporting a missing key once a key exists again, before any held send retries', async () => {
		await recordDkimSigningHold(redis, 'brand.example', 'no_key', now);
		await setDkimKey(redis, 'brand.example', 's2', 'pem', 'org-a', { awaitingDns: true });

		expect(await readDkimSigningHolds(redis, now + 60_000)).toEqual([]);
	});

	it('clears when the domain signs again', async () => {
		await recordDkimSigningHold(redis, 'brand.example', 'no_key', now);
		await clearDkimSigningHold(redis, 'brand.example');

		expect(await readDkimSigningHolds(redis, now)).toEqual([]);
	});
});
