import { ref, computed } from 'vue';
import type { Id } from '@owlat/api/dataModel';

export type ABTestType = 'subject' | 'content';
export type ABWinnerCriteria = 'open_rate' | 'click_rate' | 'manual';

export interface ABTestConfig {
	testType: ABTestType;
	variantBSubject?: string;
	variantBTemplateId?: string | null;
	splitPercentage: number;
	winnerCriteria: ABWinnerCriteria;
	testDuration?: number;
}

/**
 * Composable for managing A/B test configuration state for campaigns.
 *
 * Handles:
 * - A/B test toggle state
 * - Test type selection (subject vs content)
 * - Variant B configuration
 * - Split percentage and winner criteria
 * - Initialization from saved campaign data
 */
export function useCampaignABTest() {
	// A/B Test state
	const abTestEnabled = ref(false);
	const abTestType = ref<ABTestType>('subject');
	const abVariantBSubject = ref('');
	const abVariantBTemplateId = ref<Id<'emailTemplates'> | null>(null);
	const abSplitPercentage = ref(20);
	const abWinnerCriteria = ref<ABWinnerCriteria>('open_rate');
	const abTestDuration = ref(4);

	/**
	 * Initialize A/B test state from campaign data.
	 */
	const initializeFromCampaign = (campaign: {
		isABTest?: boolean;
		abTestConfig?: ABTestConfig | null;
	}) => {
		abTestEnabled.value = campaign.isABTest ?? false;
		if (campaign.abTestConfig) {
			const config = campaign.abTestConfig;
			abTestType.value = config.testType ?? 'subject';
			abVariantBSubject.value = config.variantBSubject ?? '';
			abVariantBTemplateId.value = (config.variantBTemplateId ??
				null) as Id<'emailTemplates'> | null;
			abSplitPercentage.value = config.splitPercentage ?? 20;
			abWinnerCriteria.value = config.winnerCriteria ?? 'open_rate';
			abTestDuration.value = config.testDuration ?? 4;
		}
	};

	/**
	 * Get the split description text for the current configuration.
	 *
	 * `splitPercentage` is the per-variant share of the test cohort.
	 * E.g., 20 means 20% A + 20% B = 40% of audience tested, 60% remainder
	 * receives the winning variant after `declareABTestWinner`. The 10–50
	 * validation range caps cohort at 100% (no negative remainder).
	 */
	const splitDescription = computed(() => {
		const variantPercent = abSplitPercentage.value;
		const remaining = Math.max(0, 100 - 2 * variantPercent);
		return {
			variantAPercent: variantPercent,
			variantBPercent: variantPercent,
			remainingPercent: remaining,
		};
	});

	/**
	 * Validate the current A/B configuration. Returns an error message when the
	 * enabled test is incomplete (missing Variant B, out-of-range split), or
	 * `null` when the config is valid — including when A/B is off. Shared by the
	 * campaign wizard's Setup step and the campaign editor so the gate is
	 * identical in both places.
	 */
	const validate = (): string | null => {
		if (!abTestEnabled.value) return null;

		if (abTestType.value === 'subject' && !abVariantBSubject.value.trim()) {
			return 'Variant B subject line is required';
		}
		if (abTestType.value === 'content' && !abVariantBTemplateId.value) {
			return 'Variant B email template is required';
		}
		if (abSplitPercentage.value < 10 || abSplitPercentage.value > 50) {
			return 'Split percentage must be between 10% and 50%';
		}
		return null;
	};

	/**
	 * Build the A/B test config payload for the enableABTest mutation.
	 */
	const buildEnablePayload = (campaignId: Id<'campaigns'>) => ({
		campaignId,
		testType: abTestType.value,
		variantBSubject: abTestType.value === 'subject' ? abVariantBSubject.value.trim() : undefined,
		variantBTemplateId: abTestType.value === 'content' ? abVariantBTemplateId.value! : undefined,
		splitPercentage: abSplitPercentage.value,
		winnerCriteria: abWinnerCriteria.value,
		testDuration: abWinnerCriteria.value !== 'manual' ? abTestDuration.value : undefined,
	});

	return {
		// State
		abTestEnabled,
		abTestType,
		abVariantBSubject,
		abVariantBTemplateId,
		abSplitPercentage,
		abWinnerCriteria,
		abTestDuration,

		// Computed
		splitDescription,

		// Methods
		initializeFromCampaign,
		validate,
		buildEnablePayload,
	};
}
