import { describe, expect, it } from 'vitest';
import { DELIVERABILITY_CHECKLIST, materializeChecklistItem } from '@owlat/shared';
import type { Id } from '../../_generated/dataModel';
import { loopbackDomains } from '../checklist';

describe('Deliverability Center loopback eligibility', () => {
	it('keeps a ready domain eligible when another domain is not ready', () => {
		const domainA = 'domain-a' as Id<'domains'>;
		const domainB = 'domain-b' as Id<'domains'>;
		const items = [
			{ scope: { kind: 'deployment' }, severity: 'blocking', status: 'pass' },
			{
				scope: { kind: 'domain', domainId: domainA, domain: 'a.example' },
				severity: 'blocking',
				status: 'pass',
			},
			{
				scope: { kind: 'domain', domainId: domainB, domain: 'b.example' },
				severity: 'blocking',
				status: 'fail',
			},
		] as never;
		const result = loopbackDomains(
			items,
			[
				{ _id: domainA, domain: 'a.example', providerType: 'mta' },
				{ _id: domainB, domain: 'b.example', providerType: 'mta' },
			] as never,
			true
		);
		expect(result).toEqual([
			{ id: domainA, domain: 'a.example', eligible: true },
			expect.objectContaining({ id: domainB, eligible: false }),
		]);
	});

	it('refuses loopback when a blocking pass is older than its hourly cadence', () => {
		const domainId = 'domain-a' as Id<'domains'>;
		const now = Date.UTC(2026, 6, 26, 12);
		const ptr = DELIVERABILITY_CHECKLIST.find((item) => item.id === 'deployment.ptr')!;
		const stalePtr = materializeChecklistItem(
			ptr,
			{ kind: 'deployment' },
			{
				provenance: 'validator',
				validator: 'test',
				status: 'pass',
				observedAt: now - 76 * 60_000,
				observedValues: [],
				diagnostic: 'PTR passed.',
				attemptId: 'stale-ptr',
			},
			now
		);

		expect(stalePtr.status).toBe('warn');
		expect(
			loopbackDomains(
				[stalePtr] as never,
				[{ _id: domainId, domain: 'a.example', providerType: 'mta' }] as never,
				true
			)
		).toEqual([
			expect.objectContaining({
				id: domainId,
				eligible: false,
				blockedReason: expect.stringContaining('server identity'),
			}),
		]);
	});
});
