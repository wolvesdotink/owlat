import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../intelligence/circuitBreaker.js', () => ({
	canSend: vi.fn(),
	reserveHalfOpenProbe: vi.fn(),
}));
vi.mock('../../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { circuitBreakerPhase } from '../circuitBreaker.js';
import * as circuitBreaker from '../../../intelligence/circuitBreaker.js';
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
		organizationId: 'org-42',
		dkimDomain: 'owlat.com',
	};
	return {
		job,
		domain: 'example.com',
		destination: {
			recipientDomain: 'example.com',
			providerKey: 'other',
			throttleKey: 'example.com',
			mx: {
				status: 'deliverable',
				source: 'mx',
				hosts: [{ exchange: 'mx.example.com', priority: 0 }],
			},
			daneDiscoveryAuthenticated: true,
		},
		fromDomain: 'owlat.com',
	};
}

const deps: PhaseDeps = { redis: {} as never, config: {} as MtaConfig };

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(circuitBreaker.canSend).mockResolvedValue({
		allowed: true,
		state: 'closed',
		generation: 0,
	});
});

describe('circuitBreakerPhase', () => {
	it('continues when the breaker is closed', async () => {
		vi.mocked(circuitBreaker.canSend).mockResolvedValue({
			allowed: true,
			state: 'closed',
			generation: 0,
		});
		const out = await circuitBreakerPhase.run(deps, makeCtx());
		expect(out.kind).toBe('continue');
		expect(circuitBreaker.canSend).toHaveBeenCalledWith(deps.redis, 'org-42');
		expect(circuitBreaker.canSend).toHaveBeenCalledWith(deps.redis, 'org-42', 'other');
	});

	it('defers using the breaker-supplied retryAfter when open', async () => {
		vi.mocked(circuitBreaker.canSend).mockResolvedValueOnce({
			allowed: false,
			state: 'open',
			retryAfter: 1_800_000,
			generation: 1,
		});
		const out = await circuitBreakerPhase.run(deps, makeCtx());
		expect(out).toEqual({
			kind: 'defer',
			delayMs: 1_800_000,
			reason: expect.stringContaining('org-42'),
		});
	});

	it('falls back to 60s when the breaker omits retryAfter', async () => {
		vi.mocked(circuitBreaker.canSend).mockResolvedValueOnce({ allowed: false, generation: 1 });
		const out = await circuitBreakerPhase.run(deps, makeCtx());
		expect(out.kind).toBe('defer');
		if (out.kind === 'defer') expect(out.delayMs).toBe(60_000);
	});

	it('defers a queued lease after the breaker generation changes', async () => {
		const ctx = makeCtx();
		ctx.job.routingLease = {
			token: 'lease',
			destinationProvider: 'other',
			probe: false,
			globalProbe: false,
			globalBreakerGeneration: 1,
			providerBreakerGeneration: 1,
		};
		vi.mocked(circuitBreaker.canSend)
			.mockResolvedValueOnce({ allowed: true, state: 'closed', generation: 2 })
			.mockResolvedValueOnce({ allowed: true, state: 'closed', generation: 1 });
		expect((await circuitBreakerPhase.run(deps, ctx)).kind).toBe('defer');
	});

	it('renews an admitted half-open probe at actual delivery time', async () => {
		const ctx = makeCtx();
		ctx.job.routingLease = {
			token: 'lease',
			destinationProvider: 'other',
			probe: true,
			globalProbe: false,
			globalBreakerGeneration: 1,
			providerBreakerGeneration: 2,
		};
		vi.mocked(circuitBreaker.canSend)
			.mockResolvedValueOnce({ allowed: true, state: 'closed', generation: 1 })
			.mockResolvedValueOnce({ allowed: true, state: 'half-open', generation: 2 });
		vi.mocked(circuitBreaker.reserveHalfOpenProbe).mockResolvedValue(true);
		expect((await circuitBreakerPhase.run(deps, ctx)).kind).toBe('continue');
		expect(circuitBreaker.reserveHalfOpenProbe).toHaveBeenCalledWith(
			deps.redis,
			'org-42',
			'other',
			'msg-1',
			expect.any(Number),
			2
		);
	});
});
