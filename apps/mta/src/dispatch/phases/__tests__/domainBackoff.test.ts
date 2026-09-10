import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../scaling/degradation.js', () => ({
	shouldBackoffDomain: vi.fn(),
}));

import { domainBackoffPhase } from '../domainBackoff.js';
import * as degradation from '../../../scaling/degradation.js';
import type { PhaseDeps } from '../../types.js';
import type { MtaConfig } from '../../../config.js';
import { makeDispatchCtx } from '../../../__tests__/helpers/dispatchCtx.js';

const deps: PhaseDeps = { redis: {} as never, config: {} as MtaConfig };

beforeEach(() => vi.clearAllMocks());

describe('domainBackoffPhase', () => {
	it('continues when no backoff is active', async () => {
		vi.mocked(degradation.shouldBackoffDomain).mockResolvedValueOnce({ backoff: false });
		const out = await domainBackoffPhase.run(deps, makeDispatchCtx());
		expect(out.kind).toBe('continue');
	});

	it('defers with helper-supplied retryAfter when backoff is active', async () => {
		vi.mocked(degradation.shouldBackoffDomain).mockResolvedValueOnce({
			backoff: true,
			retryAfter: 240_000,
		});
		const out = await domainBackoffPhase.run(deps, makeDispatchCtx());
		expect(out).toEqual({
			kind: 'defer',
			delayMs: 240_000,
			reason: expect.stringContaining('example.com'),
		});
	});

	it('falls back to 30s when retryAfter is missing', async () => {
		vi.mocked(degradation.shouldBackoffDomain).mockResolvedValueOnce({ backoff: true });
		const out = await domainBackoffPhase.run(deps, makeDispatchCtx());
		expect(out.kind).toBe('defer');
		if (out.kind === 'defer') expect(out.delayMs).toBe(30_000);
	});
});
