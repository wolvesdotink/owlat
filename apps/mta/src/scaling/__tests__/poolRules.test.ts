import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import { resolvePool, setRule, removeRule, getOrgRule, listOrgRules } from '../poolRules.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('poolRules', () => {
	let redis: InstanceType<typeof Redis>;

	beforeEach(() => {
		redis = new Redis();
	});

	describe('resolvePool', () => {
		it('returns requestedPool when no rules exist', async () => {
			const result = await resolvePool(redis, 'org-1', 'transactional');
			expect(result.pool).toBe('transactional');
			expect(result.dedicatedIp).toBeUndefined();
		});

		it('org-level rule overrides requestedPool', async () => {
			await setRule(redis, 'org-1', { pool: 'campaign' });

			const result = await resolvePool(redis, 'org-1', 'transactional');
			expect(result.pool).toBe('campaign');
		});

		it('org+fromDomain takes precedence over org-level', async () => {
			await setRule(redis, 'org-1', { pool: 'campaign' });
			await setRule(redis, 'org-1', { pool: 'transactional', fromDomain: 'notify.example.com' });

			const result = await resolvePool(redis, 'org-1', 'campaign', 'notify.example.com');
			expect(result.pool).toBe('transactional');
		});

		it('org+fromDomain+toDomain takes precedence over org+fromDomain', async () => {
			await setRule(redis, 'org-1', { pool: 'campaign', fromDomain: 'notify.example.com' });
			await setRule(redis, 'org-1', {
				pool: 'transactional',
				fromDomain: 'notify.example.com',
				toDomain: 'gmail.com',
			});

			const result = await resolvePool(redis, 'org-1', 'campaign', 'notify.example.com', 'gmail.com');
			expect(result.pool).toBe('transactional');
		});

		it('returns dedicatedIp from rule', async () => {
			await setRule(redis, 'org-1', { pool: 'transactional', dedicatedIp: '10.0.0.99' });

			const result = await resolvePool(redis, 'org-1', 'campaign');
			expect(result.dedicatedIp).toBe('10.0.0.99');
		});
	});

	describe('setRule / removeRule', () => {
		it('creates and removes a rule', async () => {
			await setRule(redis, 'org-crud', { pool: 'campaign' });

			const rule = await getOrgRule(redis, 'org-crud');
			expect(rule).not.toBeNull();
			expect(rule!.pool).toBe('campaign');

			const removed = await removeRule(redis, 'org-crud');
			expect(removed).toBe(true);

			const after = await getOrgRule(redis, 'org-crud');
			expect(after).toBeNull();
		});

		it('removeRule returns false for non-existent rule', async () => {
			const removed = await removeRule(redis, 'org-none');
			expect(removed).toBe(false);
		});
	});

	describe('listOrgRules', () => {
		it('returns all rules for an org', async () => {
			await setRule(redis, 'org-list', { pool: 'campaign' });
			await setRule(redis, 'org-list', { pool: 'transactional', fromDomain: 'a.com' });

			const rules = await listOrgRules(redis, 'org-list');
			expect(rules.length).toBe(2);
		});
	});
});
