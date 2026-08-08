import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import {
	isRoutingLeaseBoundTo,
	readRoutingLease,
	type RoutingLeaseRecord,
} from '../routingDecision.js';

function lease(overrides: Partial<RoutingLeaseRecord> = {}): RoutingLeaseRecord {
	return {
		token: 'lease-1',
		messageId: 'message-1',
		workAttemptId: 'work-1',
		routingReentryToken: 'reentry-1',
		startedAt: 1_000,
		deliveryDomain: 'production',
		organizationId: 'org-1',
		recipient: 'user@example.com',
		from: 'sender@example.org',
		messageType: 'campaign',
		candidateProvider: 'mta',
		ipPool: 'campaign',
		allowWarmupOverflow: false,
		destinationProvider: 'gmail',
		probe: false,
		globalProbe: false,
		globalBreakerGeneration: 0,
		expiresAt: 10_000,
		...overrides,
	};
}

describe('routing decision lease binding', () => {
	it('accepts only the exact tenant, message, and recipient before expiry', () => {
		expect(
			isRoutingLeaseBoundTo(
				lease(),
				{
					messageId: 'message-1',
					workAttemptId: 'work-1',
					routingReentryToken: 'reentry-1',
					startedAt: 1_000,
					deliveryDomain: 'production',
					messageType: 'campaign',
					organizationId: 'org-1',
					recipient: 'USER@example.com',
					from: 'sender@example.org',
					candidateProvider: 'mta',
					ipPool: 'campaign',
					allowWarmupOverflow: false,
				},
				9_000
			)
		).toBe(true);
	});

	it.each([
		{ messageId: 'other', organizationId: 'org-1', recipient: 'user@example.com' },
		{ messageId: 'message-1', organizationId: 'org-2', recipient: 'user@example.com' },
		{ messageId: 'message-1', organizationId: 'org-1', recipient: 'other@example.com' },
		{ from: 'other@example.org' },
		{ messageType: 'automation' as const },
		{ ipPool: 'transactional' as const },
		{ allowWarmupOverflow: true },
		{ workAttemptId: 'work-2' },
		{ routingReentryToken: 'reentry-2' },
		{ startedAt: 999 },
		{ deliveryDomain: 'member_test' as const },
	])('rejects cross-message, cross-tenant, and cross-recipient replay', (override) => {
		expect(
			isRoutingLeaseBoundTo(
				lease(),
				{
					messageId: 'message-1',
					workAttemptId: 'work-1',
					routingReentryToken: 'reentry-1',
					startedAt: 1_000,
					deliveryDomain: 'production',
					messageType: 'campaign',
					organizationId: 'org-1',
					recipient: 'user@example.com',
					from: 'sender@example.org',
					candidateProvider: 'mta',
					ipPool: 'campaign',
					allowWarmupOverflow: false,
					...override,
				},
				9_000
			)
		).toBe(false);
	});

	it('rejects an expired lease', () => {
		expect(
			isRoutingLeaseBoundTo(
				lease(),
				{
					messageId: 'message-1',
					workAttemptId: 'work-1',
					routingReentryToken: 'reentry-1',
					startedAt: 1_000,
					deliveryDomain: 'production',
					messageType: 'campaign',
					organizationId: 'org-1',
					recipient: 'user@example.com',
					from: 'sender@example.org',
					candidateProvider: 'mta',
					ipPool: 'campaign',
					allowWarmupOverflow: false,
				},
				10_001
			)
		).toBe(false);
	});
});

/**
 * The three answers a lease read may give (issue #505). `readRoutingLease` used
 * to collapse all of them into `null`, which made "our Redis lost the record"
 * indistinguishable from "the decision is stale" one layer up — and only the
 * second of those is evidence about the sending identity.
 */
describe('routing lease reads', () => {
	function redisReturning(value: string | null): Redis {
		return { get: vi.fn().mockResolvedValue(value) } as unknown as Redis;
	}

	it('returns the record while it is still current', async () => {
		const record = lease({ expiresAt: Date.now() + 60_000 });
		expect(await readRoutingLease(redisReturning(JSON.stringify(record)), 'lease-1')).toEqual({
			status: 'ok',
			lease: record,
		});
	});

	it('reports a readable record past its own deadline as expired', async () => {
		const stored = JSON.stringify(lease({ expiresAt: Date.now() - 1 }));
		expect(await readRoutingLease(redisReturning(stored), 'lease-1')).toEqual({
			status: 'expired',
		});
	});

	// A missing key is the 15-minute TTL elapsing in the ordinary case and an
	// eviction/flush/empty-replica failover in the rare one, and a `GET` cannot
	// tell them apart. `absent` keeps the stale-decision reading rather than
	// claiming a storage fault it cannot prove.
	it('reports a key Redis no longer has as absent, not as a storage fault', async () => {
		expect(await readRoutingLease(redisReturning(null), 'lease-1')).toEqual({ status: 'absent' });
	});

	it.each([
		['a truncated value', '{"token":"lease-1","messa'],
		['a value that is not an object', '42'],
		['an array', '[]'],
		['a record naming another token', JSON.stringify(lease({ token: 'lease-2' }))],
		['a record with no usable deadline', JSON.stringify(lease({ expiresAt: Number.NaN }))],
	])('reports %s as unreadable', async (_label, stored) => {
		expect(await readRoutingLease(redisReturning(stored), 'lease-1')).toEqual({
			status: 'unreadable',
		});
	});
});
