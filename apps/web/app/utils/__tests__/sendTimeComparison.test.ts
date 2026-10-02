import { describe, expect, it } from 'vitest';
import {
	compareSendTimeArms,
	MIN_DELIVERED_PER_GROUP,
	twoProportionZ,
} from '~/utils/sendTimeComparison';

const settings = { sendTimeOptimization: { holdoutPercent: 10 } };

describe('send-time comparison', () => {
	it('has nothing to compare without a comparison group', () => {
		const result = compareSendTimeArms({
			sendTimeOptimization: { holdoutPercent: 0 },
			statsSendTimeOptimizedDelivered: 5000,
			statsSendTimeOptimizedOpened: 2000,
		});
		expect(result.state).toBe('no_holdout');
	});

	it('waits until both groups have enough delivered mail', () => {
		const result = compareSendTimeArms({
			...settings,
			statsSendTimeOptimizedDelivered: 5000,
			statsSendTimeHoldoutDelivered: MIN_DELIVERED_PER_GROUP - 1,
		});
		expect(result.state).toBe('too_early');
	});

	it('calls a clear lift higher and a small wobble no difference', () => {
		const result = compareSendTimeArms({
			...settings,
			statsSendTimeOptimizedDelivered: 9000,
			statsSendTimeOptimizedOpened: 3600, // 40%
			statsSendTimeOptimizedClicked: 540, // 6.0%
			statsSendTimeHoldoutDelivered: 1000,
			statsSendTimeHoldoutOpened: 330, // 33%
			statsSendTimeHoldoutClicked: 58, // 5.8%
		});
		expect(result.state).toBe('ready');
		if (result.state !== 'ready') return;
		const [open, click] = result.metrics;
		expect(open).toMatchObject({ key: 'openRate', verdict: 'higher' });
		expect(open!.pointsChange).toBeCloseTo(7, 6);
		expect(click).toMatchObject({ key: 'clickRate', verdict: 'no_difference' });
	});

	it('calls a clear drop lower', () => {
		const result = compareSendTimeArms({
			...settings,
			statsSendTimeOptimizedDelivered: 2000,
			statsSendTimeOptimizedOpened: 500,
			statsSendTimeHoldoutDelivered: 2000,
			statsSendTimeHoldoutOpened: 700,
		});
		expect(result.state === 'ready' && result.metrics[0]!.verdict).toBe('lower');
	});

	it('computes the pooled two-proportion z statistic', () => {
		// 60/100 vs 40/100: pooled 0.5, se = sqrt(0.25 * 0.02) ≈ 0.0707.
		expect(twoProportionZ(60, 100, 40, 100)).toBeCloseTo(2.828, 3);
		expect(twoProportionZ(0, 100, 0, 100)).toBe(0);
		expect(twoProportionZ(1, 0, 1, 10)).toBe(0);
	});
});
