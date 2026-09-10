import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../intelligence/domainThrottle.js', () => ({
	acquireSlot: vi.fn(),
}));

import { acquireSlotPhase } from '../acquireSlot.js';
import * as domainThrottle from '../../../intelligence/domainThrottle.js';
import type { PhaseDeps } from '../../types.js';
import type { MtaConfig } from '../../../config.js';
import { makeCtxWithIp } from '../../../__tests__/helpers/dispatchCtx.js';

const deps: PhaseDeps = { redis: {} as never, config: {} as MtaConfig };

beforeEach(() => vi.clearAllMocks());

describe('acquireSlotPhase', () => {
	it('continues when the slot is acquired', async () => {
		vi.mocked(domainThrottle.acquireSlot).mockResolvedValueOnce(true);
		const out = await acquireSlotPhase.run(deps, makeCtxWithIp());
		expect(out.kind).toBe('continue');
	});

	it('defers 5s when the slot is not acquired', async () => {
		vi.mocked(domainThrottle.acquireSlot).mockResolvedValueOnce(false);
		const out = await acquireSlotPhase.run(deps, makeCtxWithIp());
		expect(out).toEqual({
			kind: 'defer',
			delayMs: 5_000,
			reason: expect.stringContaining('10.0.0.1'),
		});
	});

	it('forwards the IP and destination throttle identity to the helper', async () => {
		vi.mocked(domainThrottle.acquireSlot).mockResolvedValueOnce(true);
		await acquireSlotPhase.run(deps, makeCtxWithIp());
		expect(domainThrottle.acquireSlot).toHaveBeenCalledWith(
			expect.anything(),
			'10.0.0.1',
			'example.com',
			'other'
		);
	});
});
