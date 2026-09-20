/**
 * THE QUEUE PREFIX MUST NOT DEPEND ON WHICH MODULE THE GRAPH IS ENTERED AT.
 *
 * `QUEUE_KEY_NAMESPACE` used to be derived from a constant that lived in
 * `queue/setup.ts`, which imports `routes/health.ts`, which imports
 * `queue/delayedOrphans.ts` — a cycle. Entering that cycle at `setup.js` (which
 * is what the MTA's own boot does not currently do, purely by luck of import
 * order) left `QUEUE_NAMESPACE` in its temporal dead zone: real ESM throws, and
 * Vite's transform silently hands back `undefined`, so the probe watched
 * `groupmq:undefined:delayed` — a key nothing writes — and reported a perfect
 * bill of health over a delay set holding six million stranded members.
 *
 * That is the exact class of confident-empty answer the queue inspector was
 * rewritten to eliminate, so it is pinned here: the prefix is asserted after
 * the graph has been entered at `setup.js` FIRST, and asserted against a delay
 * set a real `Queue` actually wrote.
 */

import { describe, it, expect } from 'vitest';
// Deliberately first, and deliberately unused: this is the import order that
// broke the prefix. Do not reorder.
import '../setup.js';
import RedisMock from 'ioredis-mock';
import { Queue } from 'groupmq';
import type Redis from 'ioredis';
import { probeDelayedQueue, QUEUE_KEY_NAMESPACE } from '../delayedOrphans.js';
import { QUEUE_NAMESPACE } from '../namespace.js';
import { withLuaScripting } from '../../__tests__/helpers/luaScriptedRedisMock.js';

describe('queue key namespace', () => {
	it('resolves even when the module graph is entered at queue/setup.js', () => {
		expect(QUEUE_NAMESPACE).toBe('owlat-mta');
		expect(QUEUE_KEY_NAMESPACE).toBe('groupmq:owlat-mta');
		expect(QUEUE_KEY_NAMESPACE).not.toContain('undefined');
	});

	it('watches the delay set a real Queue writes, not one the prefix invented', async () => {
		const redis = new RedisMock();
		withLuaScripting(redis);
		const queue = new Queue<{ n: number }>({
			redis: redis as never,
			namespace: QUEUE_NAMESPACE,
			jobTimeoutMs: 120_000,
			maxAttempts: 5,
		});
		await queue.add({ groupId: 'transactional:example.com', data: { n: 1 }, delay: 60_000 });

		const probe = await probeDelayedQueue(redis as unknown as Redis);

		expect(probe.delayed).toBe(1);
	});
});
