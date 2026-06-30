import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../scaling/ipPool.js', () => ({
	selectIp: vi.fn(),
}));

import { selectIpPhase } from '../selectIp.js';
import * as ipPool from '../../../scaling/ipPool.js';
import type { CtxWithPool, PhaseDeps } from '../../types.js';
import type { EmailJob, IpPoolConfig } from '../../../types.js';
import type { MtaConfig } from '../../../config.js';

function makeCtx(overrides: Partial<CtxWithPool> = {}): CtxWithPool {
	const job: EmailJob = {
		messageId: 'msg-1',
		to: 'user@example.com',
		from: 'sender@owlat.com',
		subject: 'Test',
		html: '<p>Hello</p>',
		ipPool: 'transactional',
		organizationId: 'org-1',
		dkimDomain: 'owlat.com',
	};
	return {
		job,
		domain: 'example.com',
		isp: 'other',
		fromDomain: 'owlat.com',
		pool: 'transactional',
		dedicatedIp: undefined,
		...overrides,
	};
}

const ipPools: IpPoolConfig = { transactional: ['10.0.0.1'], campaign: ['10.0.0.2'] };
const deps: PhaseDeps = {
	redis: {} as never,
	config: { ipPools } as MtaConfig,
};

beforeEach(() => vi.clearAllMocks());

describe('selectIpPhase', () => {
	it('continues and enriches ctx with the selected ip', async () => {
		vi.mocked(ipPool.selectIp).mockResolvedValueOnce('10.0.0.1');
		const out = await selectIpPhase.run(deps, makeCtx());
		expect(out.kind).toBe('continue');
		if (out.kind === 'continue') expect(out.ctx.ip).toBe('10.0.0.1');
	});

	it('defers 60s when no IPs are available', async () => {
		vi.mocked(ipPool.selectIp).mockResolvedValueOnce(null);
		const out = await selectIpPhase.run(deps, makeCtx());
		expect(out).toEqual({
			kind: 'defer',
			delayMs: 60_000,
			reason: 'No IPs available for sending',
		});
	});

	it('forwards pool, ipPools config, and dedicatedIp to the helper', async () => {
		vi.mocked(ipPool.selectIp).mockResolvedValueOnce('10.0.0.99');
		const ctx = makeCtx({ pool: 'campaign', dedicatedIp: '10.0.0.99' });
		await selectIpPhase.run(deps, ctx);
		expect(ipPool.selectIp).toHaveBeenCalledWith(
			expect.anything(),
			'campaign',
			ipPools,
			'10.0.0.99',
		);
	});
});
