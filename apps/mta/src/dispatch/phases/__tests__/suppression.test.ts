import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../intelligence/suppressionList.js', () => ({
	isSuppressed: vi.fn(),
}));

import { suppressionPhase } from '../suppression.js';
import { mainPipeline } from '../index.js';
import * as suppressionList from '../../../intelligence/suppressionList.js';
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
		organizationId: 'org-1',
		dkimDomain: 'owlat.com',
	};
	return { job, domain: 'example.com', isp: 'other', fromDomain: 'owlat.com' };
}

const deps: PhaseDeps = { redis: {} as never, config: {} as MtaConfig };

beforeEach(() => vi.clearAllMocks());

describe('suppressionPhase', () => {
	it('continues when the recipient is not suppressed', async () => {
		vi.mocked(suppressionList.isSuppressed).mockResolvedValueOnce(false);
		const out = await suppressionPhase.run(deps, makeCtx());
		expect(out.kind).toBe('continue');
	});

	it('drops with status=suppressed when the recipient is on the list', async () => {
		vi.mocked(suppressionList.isSuppressed).mockResolvedValueOnce(true);
		const out = await suppressionPhase.run(deps, makeCtx());
		expect(out).toEqual({
			kind: 'drop',
			status: 'suppressed',
			reason: 'recipient_suppressed',
		});
	});

	it('queries the helper with the recipient address', async () => {
		vi.mocked(suppressionList.isSuppressed).mockResolvedValueOnce(false);
		await suppressionPhase.run(deps, makeCtx());
		expect(suppressionList.isSuppressed).toHaveBeenCalledWith(expect.anything(), 'user@example.com');
	});
});

// ── PR-72 regression-lock: suppression runs BEFORE pool/IP selection ──────
//
// A suppressed recipient must drop the attempt before any pool resolution or
// IP selection work happens — sending to a known-bad address damages the IP
// reputation, so the cheap drop has to short-circuit ahead of the resolvePool
// → selectIp enrichment. This locks that ordering against an accidental phase
// reorder in mainPipeline. See EMAIL_BEST_PRACTICES_AUDIT_2026-06-21.md "PR-72".
describe('mainPipeline ordering — suppression precedes pool/IP selection', () => {
	const order = mainPipeline.phases.map((p) => p.name);

	it('includes the suppression, resolvePool and selectIp phases', () => {
		expect(order).toContain('suppression');
		expect(order).toContain('resolve_pool');
		expect(order).toContain('select_ip');
	});

	it('suppression comes before resolvePool, which comes before selectIp', () => {
		const suppressionIdx = order.indexOf('suppression');
		const resolvePoolIdx = order.indexOf('resolve_pool');
		const selectIpIdx = order.indexOf('select_ip');
		expect(suppressionIdx).toBeGreaterThanOrEqual(0);
		expect(suppressionIdx).toBeLessThan(resolvePoolIdx);
		expect(resolvePoolIdx).toBeLessThan(selectIpIdx);
	});
});
