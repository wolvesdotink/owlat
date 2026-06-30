import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../intelligence/warming.js', () => ({
	checkCap: vi.fn(),
}));
vi.mock('../../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { warmingCapPhase } from '../warmingCap.js';
import * as warming from '../../../intelligence/warming.js';
import type { CtxWithIp, PhaseDeps } from '../../types.js';
import type { EmailJob } from '../../../types.js';
import type { MtaConfig } from '../../../config.js';

function makeCtx(): CtxWithIp {
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
		ip: '10.0.0.7',
	};
}

const deps: PhaseDeps = { redis: {} as never, config: {} as MtaConfig };

beforeEach(() => vi.clearAllMocks());

describe('warmingCapPhase', () => {
	it('continues when there is remaining warming capacity', async () => {
		vi.mocked(warming.checkCap).mockResolvedValueOnce({
			allowed: true,
			sentToday: 20,
			dailyCap: 100,
		});
		const out = await warmingCapPhase.run(deps, makeCtx());
		expect(out.kind).toBe('continue');
	});

	it('continues for graduated IPs (Infinity cap)', async () => {
		vi.mocked(warming.checkCap).mockResolvedValueOnce({
			allowed: true,
			sentToday: 0,
			dailyCap: Infinity,
		});
		const out = await warmingCapPhase.run(deps, makeCtx());
		expect(out.kind).toBe('continue');
	});

	it('defers 5 minutes when the cap is reached', async () => {
		vi.mocked(warming.checkCap).mockResolvedValueOnce({
			allowed: false,
			sentToday: 100,
			dailyCap: 100,
		});
		const out = await warmingCapPhase.run(deps, makeCtx());
		expect(out).toEqual({
			kind: 'defer',
			delayMs: 300_000,
			reason: expect.stringContaining('10.0.0.7'),
		});
	});
});
