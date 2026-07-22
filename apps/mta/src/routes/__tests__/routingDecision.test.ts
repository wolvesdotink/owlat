import { describe, expect, it } from 'vitest';
import { isRoutingLeaseBoundTo, type RoutingLeaseRecord } from '../routingDecision.js';

function lease(overrides: Partial<RoutingLeaseRecord> = {}): RoutingLeaseRecord {
	return {
		token: 'lease-1',
		messageId: 'message-1',
		workAttemptId: 'work-1',
		routingReentryToken: 'reentry-1',
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
	])('rejects cross-message, cross-tenant, and cross-recipient replay', (override) => {
		expect(
			isRoutingLeaseBoundTo(
				lease(),
				{
					messageId: 'message-1',
					workAttemptId: 'work-1',
					routingReentryToken: 'reentry-1',
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
