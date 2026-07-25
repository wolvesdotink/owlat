import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type Redis from 'ioredis';
import type { MtaConfig } from '../../config.js';

vi.mock('../../smtp/destinationProvider.js', () => ({
	resolveDestinationSnapshot: vi.fn().mockResolvedValue({ providerKey: 'gmail' }),
}));
vi.mock('../../scaling/poolRules.js', () => ({
	resolvePool: vi.fn().mockResolvedValue({ pool: 'campaign' }),
}));
vi.mock('../../scaling/ipPool.js', () => ({
	selectIpWithLease: vi.fn().mockResolvedValue({ ip: '192.0.2.10', eligibilityGeneration: 1 }),
}));

const { createRoutingDecisionHandler } = await import('../routingDecision.js');

describe('routing decision global-breaker precedence', () => {
	it('defers when global opens during a provider check instead of mapping it to relay', async () => {
		let breakerRead = 0;
		const redis = {
			hgetall: vi.fn(async (key: string) => {
				if (!key.includes(':state')) return {};
				breakerRead += 1;
				if (breakerRead === 3) {
					return { status: 'open', cooldownUntil: String(Date.now() + 90_000), generation: '3' };
				}
				return {};
			}),
		} as unknown as Redis;
		const app = new Hono();
		app.use('/send/decision', async (c, next) => {
			c.set('auth', { isMasterKey: true });
			await next();
		});
		app.post('/send/decision', createRoutingDecisionHandler(redis, {} as unknown as MtaConfig));

		const response = await app.request('/send/decision', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				messageId: 'send-1',
				workAttemptId: 'work-1',
				routingReentryToken: 'reentry-1',
				startedAt: Date.now(),
				deliveryDomain: 'production',
				messageType: 'campaign',
				organizationId: 'org-1',
				recipient: 'person@gmail.com',
				from: 'sender@example.org',
				candidateProvider: 'mta',
				ipPool: 'campaign',
				allowWarmupOverflow: false,
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			decision: 'defer',
			reason: 'global_safety',
		});
	});
});
