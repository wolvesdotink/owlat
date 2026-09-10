import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../scaling/poolRules.js', () => ({
	resolvePool: vi.fn(),
}));

import { resolvePoolPhase } from '../resolvePool.js';
import * as poolRules from '../../../scaling/poolRules.js';
import type { PhaseDeps } from '../../types.js';
import type { MtaConfig } from '../../../config.js';
import { makeDispatchCtx } from '../../../__tests__/helpers/dispatchCtx.js';
import { createOwlatJob } from '../../../__tests__/helpers/fixtures.js';

const makeCtx = () =>
	makeDispatchCtx({
		job: createOwlatJob({ from: 'sender@notify.owlat.com' }),
		fromDomain: 'notify.owlat.com',
	});

const deps: PhaseDeps = { redis: {} as never, config: {} as MtaConfig };

beforeEach(() => vi.clearAllMocks());

describe('resolvePoolPhase', () => {
	it('always continues and enriches ctx with resolved pool', async () => {
		vi.mocked(poolRules.resolvePool).mockResolvedValueOnce({ pool: 'campaign' });
		const out = await resolvePoolPhase.run(deps, makeCtx());
		expect(out.kind).toBe('continue');
		if (out.kind === 'continue') {
			expect(out.ctx.pool).toBe('campaign');
			expect(out.ctx.dedicatedIp).toBeUndefined();
		}
	});

	it('passes a dedicatedIp through when the helper returns one', async () => {
		vi.mocked(poolRules.resolvePool).mockResolvedValueOnce({
			pool: 'transactional',
			dedicatedIp: '10.0.0.99',
		});
		const out = await resolvePoolPhase.run(deps, makeCtx());
		if (out.kind === 'continue') expect(out.ctx.dedicatedIp).toBe('10.0.0.99');
	});

	it('forwards orgId, requested pool, and both domains to the helper', async () => {
		vi.mocked(poolRules.resolvePool).mockResolvedValueOnce({ pool: 'transactional' });
		await resolvePoolPhase.run(deps, makeCtx());
		expect(poolRules.resolvePool).toHaveBeenCalledWith(
			expect.anything(),
			'org-1',
			'transactional',
			'notify.owlat.com',
			'example.com'
		);
	});
});
