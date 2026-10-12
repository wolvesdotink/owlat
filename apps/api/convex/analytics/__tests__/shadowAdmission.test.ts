/**
 * D4's shadow allowance for the decisions lane (ADR-0073): off unless the
 * task's switch is at `shadow`, a stable share of messages, and money bounded
 * by the day's shadow allowance, with or without a daily ceiling.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { newHarness } from '../../__tests__/testModules';
import { admitShadow } from '../shadowAdmission';
import { shadowSamplePoint } from '../../lib/aiRouting/shadowSampling';
import { actionCtxOver, reconcileSpend } from '../../aiRouting/__tests__/spend.testlib';

afterEach(() => {
	vi.unstubAllEnvs();
});

/** A message key the 10% sample takes. */
function sampledKey(): string {
	for (let index = 0; ; index++) {
		if (shadowSamplePoint('mail.category', `m${index}`) < 0.1) return `m${index}`;
	}
}

async function shadowPolicy(t: ReturnType<typeof newHarness>, shadowCapUsd?: number) {
	await t.run((ctx) =>
		ctx.db.insert('aiRoutingPolicy', {
			categoryDisplayBundle: 'shadow',
			...(shadowCapUsd === undefined ? {} : { shadowCapUsd }),
			policyVersion: 3,
			updatedAt: Date.now(),
			updatedBy: 'admin',
		})
	);
}

describe('admitShadow', () => {
	it('shadows nothing by default', async () => {
		const t = newHarness();
		const { ctx } = actionCtxOver(t);
		expect(
			await admitShadow(ctx, { task: 'mail.category', subjectKey: sampledKey(), feature: 'x' })
		).toEqual({ isAdmitted: false, why: 'not_shadowed' });
	});

	it('admits a sampled message as shadow, background work within the allowance', async () => {
		const t = newHarness();
		await reconcileSpend(t);
		await shadowPolicy(t, 1);
		const { ctx } = actionCtxOver(t);
		const verdict = await admitShadow(ctx, {
			task: 'mail.category',
			subjectKey: sampledKey(),
			feature: 'postbox_category',
		});
		expect(verdict).toMatchObject({
			isAdmitted: true,
			target: {
				task: 'mail.category',
				budgetClass: 'shadow',
				priority: 'background',
				policyVersion: 3,
			},
		});
	});

	it('refuses without a finite shadow cap when no daily ceiling is set', async () => {
		const t = newHarness();
		await reconcileSpend(t);
		await shadowPolicy(t);
		const { ctx } = actionCtxOver(t);
		expect(
			await admitShadow(ctx, { task: 'mail.category', subjectKey: sampledKey(), feature: 'x' })
		).toEqual({ isAdmitted: false, why: 'no_allowance' });
	});

	it('refuses while the spend state cannot be verified', async () => {
		const t = newHarness();
		await shadowPolicy(t, 1);
		const { ctx } = actionCtxOver(t);
		expect(
			await admitShadow(ctx, { task: 'mail.category', subjectKey: sampledKey(), feature: 'x' })
		).toEqual({ isAdmitted: false, why: 'no_allowance' });
	});

	it('leaves an unsampled message alone', async () => {
		const t = newHarness();
		await shadowPolicy(t, 1);
		const { ctx } = actionCtxOver(t);
		let key = 'u0';
		for (let index = 0; shadowSamplePoint('mail.category', key) < 0.1; index++) key = `u${index}`;
		expect(
			await admitShadow(ctx, { task: 'mail.category', subjectKey: key, feature: 'x' })
		).toEqual({
			isAdmitted: false,
			why: 'not_sampled',
		});
	});
});
