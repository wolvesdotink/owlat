import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../intelligence/orgLimits.js', () => ({
	checkAndIncrement: vi.fn(),
}));

import { orgLimitPhase } from '../orgLimit.js';
import * as orgLimits from '../../../intelligence/orgLimits.js';
import type { BasePhaseCtx, PhaseDeps } from '../../types.js';
import type { EmailJob } from '../../../types.js';
import type { MtaConfig } from '../../../config.js';

function makeCtx(): BasePhaseCtx {
	const job: EmailJob = {
		messageId: 'msg-1',
		to: 'user@example.com',
		from: 'sender@owlat.com',
		subject: 'Test',
		html: '<p>Hello</p>',
		ipPool: 'transactional',
		organizationId: 'org-7',
		dkimDomain: 'owlat.com',
	};
	return { job, domain: 'example.com', isp: 'other', fromDomain: 'owlat.com' };
}

const deps: PhaseDeps = { redis: {} as never, config: {} as MtaConfig };

beforeEach(() => vi.clearAllMocks());

describe('orgLimitPhase', () => {
	it('continues when the limit check allows', async () => {
		vi.mocked(orgLimits.checkAndIncrement).mockResolvedValueOnce({ allowed: true });
		const out = await orgLimitPhase.run(deps, makeCtx());
		expect(out.kind).toBe('continue');
	});

	it('defers using helper-supplied retryAfter when limit is hit', async () => {
		vi.mocked(orgLimits.checkAndIncrement).mockResolvedValueOnce({
			allowed: false,
			retryAfter: 4_500_000,
		});
		const out = await orgLimitPhase.run(deps, makeCtx());
		expect(out).toEqual({
			kind: 'defer',
			delayMs: 4_500_000,
			reason: expect.stringContaining('org-7'),
		});
	});

	it('falls back to 60s when helper omits retryAfter', async () => {
		vi.mocked(orgLimits.checkAndIncrement).mockResolvedValueOnce({ allowed: false });
		const out = await orgLimitPhase.run(deps, makeCtx());
		expect(out.kind).toBe('defer');
		if (out.kind === 'defer') expect(out.delayMs).toBe(60_000);
	});
});
