import { describe, expect, it } from 'vitest';
import {
	DELIVERABILITY_CHECKLIST,
	dependenciesPass,
	deriveDeliverabilityGrade,
	materializeChecklistItem,
	selectNextDeliverabilityItem,
	type DeliverabilityChecklistItem,
} from '../deliverabilityChecklist';

const domainSpf = DELIVERABILITY_CHECKLIST.find((item) => item.id === 'domain.spf')!;
const domainDkim = DELIVERABILITY_CHECKLIST.find((item) => item.id === 'domain.dkim')!;
const domainDmarc = DELIVERABILITY_CHECKLIST.find((item) => item.id === 'domain.dmarc')!;

function item(
	definition: typeof domainSpf,
	domainId: string,
	status: DeliverabilityChecklistItem['status']
): DeliverabilityChecklistItem {
	return materializeChecklistItem(
		definition,
		{ kind: 'domain', domainId, domain: `${domainId}.example` },
		{
			provenance: 'validator',
			validator: 'test',
			status,
			observedAt: 10,
			observedValues: [],
			diagnostic: status,
			attemptId: `attempt-${domainId}-${definition.id}`,
		}
	);
}

describe('deliverability checklist reducer', () => {
	it('links to the canonical external docs guides and stable anchors', () => {
		expect(
			DELIVERABILITY_CHECKLIST.every((entry) =>
				entry.docsHref.startsWith('https://docs.owlat.app/')
			)
		).toBe(true);
		expect(
			DELIVERABILITY_CHECKLIST.find((entry) => entry.id === 'deployment.ptr')?.docsHref
		).toContain('/guide/sending-from-a-vps#');
		expect(DELIVERABILITY_CHECKLIST.find((entry) => entry.id === 'domain.spf')?.docsHref).toContain(
			'/guide/deliverability#'
		);
	});

	it('does not synthesize a pass without validator evidence', () => {
		const result = materializeChecklistItem(
			domainSpf,
			{ kind: 'domain', domainId: 'a', domain: 'a' },
			null
		);
		expect(result).toMatchObject({ status: 'fail' });
		expect(result).not.toHaveProperty('lastCheckedAt');
	});

	it('derives the status sentence grade from consequence and live status', () => {
		expect(deriveDeliverabilityGrade([item(domainSpf, 'a', 'fail')])).toBe('at_risk');
		expect(deriveDeliverabilityGrade([item(domainSpf, 'a', 'pending-dns')])).toBe(
			'needs_attention'
		);
		expect(deriveDeliverabilityGrade([item(domainSpf, 'a', 'pass')])).toBe('ready');
		expect(
			deriveDeliverabilityGrade([
				{
					...item(domainSpf, 'a', 'warn'),
					severity: 'recommended',
				},
			])
		).toBe('ready');
	});

	it('keeps dependencies scoped to their own sending domain', () => {
		const items = [
			item(domainSpf, 'domain-a', 'pass'),
			item(domainDkim, 'domain-a', 'pass'),
			item(domainSpf, 'domain-b', 'fail'),
			item(domainDkim, 'domain-b', 'pass'),
			item(domainDmarc, 'domain-b', 'fail'),
		];
		expect(dependenciesPass(items[4]!, items)).toBe(false);
		expect(selectNextDeliverabilityItem(items)?.scope).toMatchObject({
			kind: 'domain',
			domainId: 'domain-b',
		});
	});
});
