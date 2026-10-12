/**
 * D4's message share is counted, not sampled (ADR-0073, Sol r1 F6): over any
 * prefix of a day's eligible messages, at most floor(share × eligible) are
 * shadowed, and asking again for a message changes nothing.
 */

import { describe, expect, it } from 'vitest';
import { resolveRoutingPolicy } from '@owlat/shared/aiRouting';
import { internal } from '../../_generated/api';
import { newHarness } from '../../__tests__/testModules';
import { shadowSample } from '../../lib/aiRouting/shadowSampling';

const policy = resolveRoutingPolicy({
	policyVersion: 1,
	updatedAt: 1,
	updatedBy: 'admin',
	categoryDisplayBundle: 'shadow',
} as never);

describe('aiRouting.shadowQuota.claimShadowSlot', () => {
	it('never admits more than floor(10% × eligible), at any point of the day', async () => {
		const t = newHarness();
		let admitted = 0;
		for (let index = 0; index < 1_000; index++) {
			const key = `${index}`;
			const { isAdmitted } = await t.mutation(internal.aiRouting.shadowQuota.claimShadowSlot, {
				task: 'mail.category',
				subjectKey: key,
				isCandidate: shadowSample(policy, 'mail.category', key).isSampled,
			});
			if (isAdmitted) admitted++;
			expect(admitted).toBeLessThanOrEqual(Math.floor(0.1 * (index + 1)));
		}
		expect(admitted).toBeGreaterThan(50);
		expect(admitted).toBeLessThanOrEqual(100);
	}, 60_000);

	it('answers a repeated message the same way, counting it once', async () => {
		const t = newHarness();
		for (let index = 0; index < 20; index++) {
			await t.mutation(internal.aiRouting.shadowQuota.claimShadowSlot, {
				task: 'mail.category',
				subjectKey: `filler-${index}`,
				isCandidate: false,
			});
		}
		const first = await t.mutation(internal.aiRouting.shadowQuota.claimShadowSlot, {
			task: 'mail.category',
			subjectKey: 'repeat',
			isCandidate: true,
		});
		const again = await t.mutation(internal.aiRouting.shadowQuota.claimShadowSlot, {
			task: 'mail.category',
			subjectKey: 'repeat',
			isCandidate: true,
		});
		expect(first).toEqual({ isAdmitted: true });
		expect(again).toEqual({ isAdmitted: true });
		const [day] = await t.run((ctx) => ctx.db.query('shadowQuotaDays').collect());
		expect(day).toMatchObject({ eligibleCount: 21, admittedCount: 1 });
	});

	it('never admits a message the hash did not choose', async () => {
		const t = newHarness();
		for (let index = 0; index < 50; index++) {
			const { isAdmitted } = await t.mutation(internal.aiRouting.shadowQuota.claimShadowSlot, {
				task: 'mail.category',
				subjectKey: `x-${index}`,
				isCandidate: false,
			});
			expect(isAdmitted).toBe(false);
		}
	});
});
