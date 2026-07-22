import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';

const resolveLastMileRouting = vi.hoisted(() => vi.fn());
const sendProviderDispatch = vi.hoisted(() => vi.fn());

vi.mock('../../delivery/lastMileRouting', () => ({ resolveLastMileRouting }));
vi.mock('../../lib/sendProviders/dispatch', () => ({ sendProviderDispatch }));

const { dispatchGovernedTestEmail } = await import('../testSend');

const ctx = {} as ActionCtx;
const params = {
	to: 'member@example.com',
	from: 'Owlat <sender@example.org>',
	subject: '[TEST] Hello',
	html: '<p>Hello</p>',
};

describe('campaign and template test-send routing', () => {
	beforeEach(() => {
		resolveLastMileRouting.mockReset();
		sendProviderDispatch.mockReset();
	});

	it('resolves the current transactional route and forwards the exact MTA lease', async () => {
		resolveLastMileRouting.mockResolvedValue({
			kind: 'ready',
			providerKind: 'mta',
			organizationId: 'org-1',
			routingLease: 'lease-1',
			route: { ipPool: 'transactional' },
		});
		sendProviderDispatch.mockResolvedValue({ result: { success: true, id: 'queued-1' } });

		await dispatchGovernedTestEmail(ctx, params);

		expect(resolveLastMileRouting).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				messageType: 'transactional',
				to: params.to,
				from: params.from,
				idempotencyKey: expect.stringMatching(/^test_/),
			})
		);
		const decision = resolveLastMileRouting.mock.calls[0]![1];
		expect(sendProviderDispatch).toHaveBeenCalledWith(ctx, 'mta', params, {
			messageId: decision.idempotencyKey,
			messageType: 'transactional',
			organizationId: 'org-1',
			routingLease: 'lease-1',
			ipPool: 'transactional',
		});
	});

	it('does not dispatch when the authoritative decision defers', async () => {
		resolveLastMileRouting.mockResolvedValue({ kind: 'defer', retryAfterMs: 30_000 });

		await expect(dispatchGovernedTestEmail(ctx, params)).rejects.toThrow(
			'Delivery safety policy deferred this test'
		);
		expect(sendProviderDispatch).not.toHaveBeenCalled();
	});
});
