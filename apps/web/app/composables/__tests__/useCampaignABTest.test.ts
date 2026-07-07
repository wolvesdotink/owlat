import { describe, it, expect } from 'vitest';

import { useCampaignABTest } from '../useCampaignABTest';

describe('useCampaignABTest', () => {
	it('starts disabled — the Setup step A/B expander is hidden by default', () => {
		const ab = useCampaignABTest();
		expect(ab.abTestEnabled.value).toBe(false);
		// A disabled test is always valid (nothing to gate on).
		expect(ab.validate()).toBeNull();
	});

	it('gates advance: an enabled subject test needs a Variant B subject', () => {
		const ab = useCampaignABTest();
		ab.abTestEnabled.value = true;
		ab.abTestType.value = 'subject';
		ab.abVariantBSubject.value = '';
		expect(ab.validate()).toBe('Variant B subject line is required');

		ab.abVariantBSubject.value = 'A fresher subject';
		expect(ab.validate()).toBeNull();
	});

	it('gates advance: an enabled content test needs a Variant B template', () => {
		const ab = useCampaignABTest();
		ab.abTestEnabled.value = true;
		ab.abTestType.value = 'content';
		ab.abVariantBTemplateId.value = null;
		expect(ab.validate()).toBe('Variant B email template is required');
	});

	it('gates advance: the split percentage must stay within 10–50%', () => {
		const ab = useCampaignABTest();
		ab.abTestEnabled.value = true;
		ab.abTestType.value = 'subject';
		ab.abVariantBSubject.value = 'B';
		ab.abSplitPercentage.value = 5;
		expect(ab.validate()).toBe('Split percentage must be between 10% and 50%');
		ab.abSplitPercentage.value = 60;
		expect(ab.validate()).toBe('Split percentage must be between 10% and 50%');
		ab.abSplitPercentage.value = 25;
		expect(ab.validate()).toBeNull();
	});

	it('re-opens an existing A/B config from a saved campaign draft', () => {
		const ab = useCampaignABTest();
		ab.initializeFromCampaign({
			isABTest: true,
			abTestConfig: {
				testType: 'content',
				variantBTemplateId: 'tmpl_b',
				splitPercentage: 30,
				winnerCriteria: 'click_rate',
				testDuration: 8,
			},
		});
		expect(ab.abTestEnabled.value).toBe(true);
		expect(ab.abTestType.value).toBe('content');
		expect(ab.abVariantBTemplateId.value).toBe('tmpl_b');
		expect(ab.abSplitPercentage.value).toBe(30);
		expect(ab.abWinnerCriteria.value).toBe('click_rate');
		expect(ab.abTestDuration.value).toBe(8);
	});

	it('omits the winner duration from the enable payload for manual selection', () => {
		const ab = useCampaignABTest();
		ab.abTestType.value = 'subject';
		ab.abVariantBSubject.value = ' Trimmed ';
		ab.abWinnerCriteria.value = 'manual';
		const payload = ab.buildEnablePayload('camp_1' as never);
		expect(payload.variantBSubject).toBe('Trimmed');
		expect(payload.testDuration).toBeUndefined();
	});
});
