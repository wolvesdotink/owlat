import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import type { FunctionReference } from 'convex/server';
import { holdConvexQuery } from '../convexQueryHold';
import { SUBSCRIPTION_LINGER_MS } from '../sharedConvexSubscriptions';
import { useConvexQuery } from '~/composables/useConvexQuery';

const query = 'mail/mailbox/messages:listThreadMessages' as unknown as FunctionReference<'query'>;

/** `ConvexClient.onUpdate` with a handle that answers `getCurrentValue`. */
function fakeClient() {
	const wire: Array<{ push: (value: unknown) => void; closed: boolean }> = [];
	const onUpdate = vi.fn((_query: unknown, _args: unknown, update: (value: unknown) => void) => {
		let current: unknown;
		const sub = {
			push: (value: unknown) => {
				current = value;
				update(value);
			},
			closed: false,
		};
		wire.push(sub);
		return Object.assign(
			() => {
				sub.closed = true;
			},
			{ getCurrentValue: () => current }
		);
	});
	return { client: { onUpdate }, onUpdate, wire };
}

describe('holdConvexQuery', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('shares its subscription with a later useConvexQuery of the same args, which reads it at once', () => {
		const fake = fakeClient();
		vi.stubGlobal('useConvex', () => fake.client);
		const seen: unknown[] = [];
		const release = holdConvexQuery(fake.client, query, { messageId: 'm1' } as never, (v) =>
			seen.push(v)
		);
		fake.wire[0]?.push({ messages: ['warm'] });
		expect(seen).toEqual([{ messages: ['warm'] }]);

		const scope = effectScope();
		const result = scope.run(() => useConvexQuery(query, { messageId: 'm1' } as never));

		// One wire subscription, and the reader has the value in the same tick.
		expect(fake.onUpdate).toHaveBeenCalledTimes(1);
		expect(result?.data.value).toEqual({ messages: ['warm'] });
		expect(result?.isLoading.value).toBe(false);

		release();
		scope.stop();
	});

	it('lingers after release and closes once the linger runs out', () => {
		const fake = fakeClient();
		const release = holdConvexQuery(fake.client, query, { messageId: 'm2' } as never);
		release();
		expect(fake.wire[0]?.closed).toBe(false);
		vi.advanceTimersByTime(SUBSCRIPTION_LINGER_MS);
		expect(fake.wire[0]?.closed).toBe(true);
	});
});
