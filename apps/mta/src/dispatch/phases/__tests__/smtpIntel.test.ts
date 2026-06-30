import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../intelligence/smtpResponse.js', () => ({
	shouldDefer: vi.fn(),
}));
vi.mock('../../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { smtpIntelPhase } from '../smtpIntel.js';
import * as smtpResponse from '../../../intelligence/smtpResponse.js';
import type { BasePhaseCtx, PhaseDeps } from '../../types.js';
import type { EmailJob } from '../../../types.js';
import type { MtaConfig } from '../../../config.js';

function makeCtx(): BasePhaseCtx {
	const job: EmailJob = {
		messageId: 'msg-1',
		to: 'user@gmail.com',
		from: 'sender@owlat.com',
		subject: 'Test',
		html: '<p>Hello</p>',
		ipPool: 'transactional',
		organizationId: 'org-1',
		dkimDomain: 'owlat.com',
	};
	return { job, domain: 'gmail.com', isp: 'gmail', fromDomain: 'owlat.com' };
}

const deps: PhaseDeps = { redis: {} as never, config: {} as MtaConfig };

beforeEach(() => vi.clearAllMocks());

describe('smtpIntelPhase', () => {
	it('continues when shouldDefer returns 0', async () => {
		vi.mocked(smtpResponse.shouldDefer).mockResolvedValueOnce(0);
		const out = await smtpIntelPhase.run(deps, makeCtx());
		expect(out.kind).toBe('continue');
	});

	it('defers with the helper-supplied delay when shouldDefer > 0', async () => {
		vi.mocked(smtpResponse.shouldDefer).mockResolvedValueOnce(120_000);
		const out = await smtpIntelPhase.run(deps, makeCtx());
		expect(out).toEqual({
			kind: 'defer',
			delayMs: 120_000,
			reason: expect.stringContaining('gmail.com'),
		});
	});
});
