import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import RedisMock from 'ioredis-mock';

vi.mock('../../../intelligence/suppressionList.js', () => ({
	isSuppressed: vi.fn(),
}));

import { suppressionPhase } from '../suppression.js';
import { mainPipeline } from '../index.js';
import * as suppressionList from '../../../intelligence/suppressionList.js';
import type { PhaseDeps } from '../../types.js';
import type { MtaConfig } from '../../../config.js';
import { makeDispatchCtx } from '../../../__tests__/helpers/dispatchCtx.js';
import { createOwlatJob, createTestConfig } from '../../../__tests__/helpers/fixtures.js';
import { recordMarketingOptOut } from '../../../intelligence/marketingOptOut.js';
import type { EmailJob } from '../../../types.js';

const deps: PhaseDeps = { redis: {} as never, config: {} as MtaConfig };

beforeEach(() => vi.clearAllMocks());

describe('suppressionPhase', () => {
	it('continues when the recipient is not suppressed', async () => {
		vi.mocked(suppressionList.isSuppressed).mockResolvedValueOnce(false);
		const out = await suppressionPhase.run(deps, makeDispatchCtx());
		expect(out.kind).toBe('continue');
	});

	it('drops with status=suppressed when the recipient is on the list', async () => {
		vi.mocked(suppressionList.isSuppressed).mockResolvedValueOnce(true);
		const out = await suppressionPhase.run(deps, makeDispatchCtx());
		expect(out).toEqual({
			kind: 'drop',
			status: 'suppressed',
			reason: 'recipient_suppressed',
		});
	});

	it('queries the helper with the recipient address', async () => {
		vi.mocked(suppressionList.isSuppressed).mockResolvedValueOnce(false);
		await suppressionPhase.run(deps, makeDispatchCtx());
		expect(suppressionList.isSuppressed).toHaveBeenCalledWith(
			expect.anything(),
			'user@example.com'
		);
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

describe('suppressionPhase — mail queued before a marketing opt-out', () => {
	const OPTED_OUT_AT = 1_700_000_000_000;
	const HOUR = 60 * 60 * 1000;
	const config = createTestConfig();
	let redis: InstanceType<typeof RedisMock>;
	let optOutDeps: PhaseDeps;

	beforeEach(async () => {
		vi.mocked(suppressionList.isSuppressed).mockResolvedValue(false);
		redis = new RedisMock();
		await redis.flushall();
		optOutDeps = { redis: redis as never, config };
		await recordMarketingOptOut(
			redis as never,
			{ organizationId: 'org-1', email: 'User@Example.com', optedOutAt: OPTED_OUT_AT },
			config,
			OPTED_OUT_AT
		);
	});

	afterEach(async () => {
		await redis.quit();
	});

	const queued = (overrides: Partial<EmailJob>) =>
		makeDispatchCtx({
			job: createOwlatJob({ firstEnqueuedAt: OPTED_OUT_AT - 3 * HOUR, ...overrides }),
		});

	it('withdraws a deferred campaign message to the address', async () => {
		const out = await suppressionPhase.run(optOutDeps, queued({ messageType: 'campaign' }));
		expect(out).toEqual({ kind: 'drop', status: 'unsubscribed', reason: 'recipient_unsubscribed' });
	});

	it('withdraws an automation message to the address', async () => {
		const out = await suppressionPhase.run(optOutDeps, queued({ messageType: 'automation' }));
		expect(out.kind).toBe('drop');
	});

	it('leaves a transactional message to the same address alone', async () => {
		const out = await suppressionPhase.run(optOutDeps, queued({ messageType: 'transactional' }));
		expect(out.kind).toBe('continue');
	});

	it('leaves a job that carries no stream alone', async () => {
		const out = await suppressionPhase.run(optOutDeps, queued({}));
		expect(out.kind).toBe('continue');
	});

	it("leaves another organization's campaign to the same address alone", async () => {
		const out = await suppressionPhase.run(
			optOutDeps,
			queued({ messageType: 'campaign', organizationId: 'org-2' })
		);
		expect(out.kind).toBe('continue');
	});

	it('leaves a campaign that started dispatching after a re-subscribe alone', async () => {
		const out = await suppressionPhase.run(
			optOutDeps,
			queued({ messageType: 'campaign', firstEnqueuedAt: OPTED_OUT_AT + HOUR })
		);
		expect(out.kind).toBe('continue');
	});

	it('keeps the latest opt-out when an older one arrives late', async () => {
		await recordMarketingOptOut(
			redis as never,
			{ organizationId: 'org-1', email: 'user@example.com', optedOutAt: OPTED_OUT_AT - 5 * HOUR },
			config,
			OPTED_OUT_AT
		);
		const out = await suppressionPhase.run(optOutDeps, queued({ messageType: 'campaign' }));
		expect(out.kind).toBe('drop');
	});
});
