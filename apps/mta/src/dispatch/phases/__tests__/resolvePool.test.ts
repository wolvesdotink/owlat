import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../scaling/poolRules.js', () => ({
	resolvePool: vi.fn(),
}));

import { resolvePoolPhase } from '../resolvePool.js';
import * as poolRules from '../../../scaling/poolRules.js';
import type { BasePhaseCtx, PhaseDeps } from '../../types.js';
import type { EmailJob } from '../../../types.js';
import type { MtaConfig } from '../../../config.js';

function makeCtx(): BasePhaseCtx {
	const job: EmailJob = {
		messageId: 'msg-1',
		to: 'user@example.com',
		from: 'sender@notify.owlat.com',
		subject: 'Test',
		html: '<p>Hello</p>',
		ipPool: 'transactional',
		organizationId: 'org-1',
		dkimDomain: 'owlat.com',
	};
	return { job, domain: 'example.com', isp: 'other', fromDomain: 'notify.owlat.com' };
}

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
			'example.com',
		);
	});
});
