import { describe, expect, it } from 'vitest';
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
});
