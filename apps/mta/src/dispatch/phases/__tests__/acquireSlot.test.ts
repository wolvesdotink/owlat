import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../intelligence/domainThrottle.js', () => ({
	acquireSlot: vi.fn(),
}));

import { acquireSlotPhase } from '../acquireSlot.js';
import * as domainThrottle from '../../../intelligence/domainThrottle.js';
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
		providerKey: 'other',
		throttleKey: 'example.com',
		destination: {
			recipientDomain: 'example.com',
			providerKey: 'other',
			throttleKey: 'example.com',
		},
		fromDomain: 'owlat.com',
		pool: 'transactional',
		dedicatedIp: undefined,
		ip: '10.0.0.1',
	};
}

const deps: PhaseDeps = { redis: {} as never, config: {} as MtaConfig };

beforeEach(() => vi.clearAllMocks());

describe('acquireSlotPhase', () => {
	it('continues when the slot is acquired', async () => {
		vi.mocked(domainThrottle.acquireSlot).mockResolvedValueOnce(true);
		const out = await acquireSlotPhase.run(deps, makeCtx());
		expect(out.kind).toBe('continue');
	});

	it('defers 5s when the slot is not acquired', async () => {
		vi.mocked(domainThrottle.acquireSlot).mockResolvedValueOnce(false);
		const out = await acquireSlotPhase.run(deps, makeCtx());
		expect(out).toEqual({
			kind: 'defer',
			delayMs: 5_000,
			reason: expect.stringContaining('10.0.0.1'),
		});
	});

	it('forwards ip and domain to the helper', async () => {
		vi.mocked(domainThrottle.acquireSlot).mockResolvedValueOnce(true);
		await acquireSlotPhase.run(deps, makeCtx());
		expect(domainThrottle.acquireSlot).toHaveBeenCalledWith(
			expect.anything(),
			'10.0.0.1',
			'example.com',
			'other'
		);
	});
});
