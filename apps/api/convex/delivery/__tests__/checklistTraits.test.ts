import { DELIVERABILITY_CHECKLIST } from '@owlat/shared';
import { describe, expect, it } from 'vitest';
import {
	CHECKLIST_ITEM_TRAITS,
	DEPLOYMENT_CHECK_IDS,
	DOMAIN_CHECK_IDS,
	checklistTraits,
} from '../checklistTraits';

describe('deliverability checklist trait registry', () => {
	it('classifies every canonical checklist item exactly once', () => {
		const canonicalIds = DELIVERABILITY_CHECKLIST.map((item) => item.id).sort();
		expect(Object.keys(CHECKLIST_ITEM_TRAITS).sort()).toEqual(canonicalIds);
		expect([...DEPLOYMENT_CHECK_IDS, ...DOMAIN_CHECK_IDS].sort()).toEqual(canonicalIds);
		expect(new Set([...DEPLOYMENT_CHECK_IDS, ...DOMAIN_CHECK_IDS]).size).toBe(canonicalIds.length);
		expect(
			DEPLOYMENT_CHECK_IDS.every((itemId) => checklistTraits(itemId).scope === 'deployment')
		).toBe(true);
		expect(DOMAIN_CHECK_IDS.every((itemId) => checklistTraits(itemId).scope === 'domain')).toBe(
			true
		);
	});

	it('describes precise lazy context dependencies without duplicates', () => {
		expect(checklistTraits('deployment.ptr').contextDependencies).toEqual(['warming']);
		expect(checklistTraits('deployment.port25').contextDependencies).toEqual([
			'warming',
			'mta_health',
		]);
		expect(checklistTraits('deployment.tls').contextDependencies).toEqual(['mta_health']);
		expect(checklistTraits('deployment.relay').contextDependencies).toEqual(['relay']);
		expect(checklistTraits('domain.tracking').contextDependencies).toEqual(['tracking']);
		expect(checklistTraits('domain.spam_rate').contextDependencies).toEqual(['postmaster']);
		for (const traits of Object.values(CHECKLIST_ITEM_TRAITS)) {
			expect(new Set(traits.contextDependencies).size).toBe(traits.contextDependencies.length);
		}
	});
});
