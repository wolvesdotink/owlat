import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../intelligence/orgLimits.js', () => ({
	checkAndIncrement: vi.fn(),
}));

import { orgLimitPhase } from '../orgLimit.js';
import * as orgLimits from '../../../intelligence/orgLimits.js';
import type { PhaseDeps } from '../../types.js';
import type { MtaConfig } from '../../../config.js';
import { makeDispatchCtx } from '../../../__tests__/helpers/dispatchCtx.js';
import { createOwlatJob } from '../../../__tests__/helpers/fixtures.js';

const makeCtx = () => makeDispatchCtx({ job: createOwlatJob({ organizationId: 'org-7' }) });

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
