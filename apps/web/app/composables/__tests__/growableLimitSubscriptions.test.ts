/**
 * The growable-limit lists (chat history, grouped Postbox) keep one live
 * window, not one per size they passed through (#924). Drives the real
 * composables through useConvexQuery and the shared-subscription registry
 * against a fake Convex client that counts wire subscriptions and re-runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { getFunctionName } from 'convex/server';
import { useConvexQuery } from '../useConvexQuery';
import { useGrowableLimit } from '../postbox/useGrowableLimit';
import {
	resetSharedConvexSubscriptions,
	SUBSCRIPTION_LINGER_MS,
} from '~/lib/sharedConvexSubscriptions';

const CHAT = 'chat/messages:listMessages';
const THREADS = 'mail/mailbox/queries:listThreads';

interface Wire {
	name: string;
	args: Record<string, unknown>;
	live: boolean;
	current: unknown;
	update: (value: unknown) => void;
}

function fakeClient() {
	const wire: Wire[] = [];
	let executions = 0;
	const client = {
		onUpdate: (query: unknown, args: Record<string, unknown>, update: (value: unknown) => void) => {
			const sub: Wire = {
				name: getFunctionName(query as never),
				args,
				live: true,
				current: undefined,
				update,
			};
			wire.push(sub);
			return Object.assign(
				() => {
					sub.live = false;
				},
				{ getCurrentValue: () => sub.current }
			);
		},
	};
	/** A relevant write: the server re-runs every live subscription of `name`. */
	const serverTick = (name: string) => {
		for (const sub of wire.filter((w) => w.live && w.name === name)) {
			executions += 1;
			const rows = Array.from({ length: Number(sub.args.limit ?? 0) }, (_, i) => ({ _id: i }));
			sub.current =
				name === CHAT ? { messages: rows, hasMore: true } : { threads: rows, hasMore: true };
			sub.update(sub.current);
		}
	};
	const live = (name: string) => wire.filter((w) => w.live && w.name === name);
	return { client, wire, serverTick, live, executions: () => executions };
}

let fake: ReturnType<typeof fakeClient>;

beforeEach(() => {
	vi.useFakeTimers();
	fake = fakeClient();
	vi.stubGlobal('useConvex', () => fake.client);
	vi.stubGlobal('useConvexQuery', useConvexQuery);
	vi.stubGlobal('useGrowableLimit', useGrowableLimit);
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn() }));
});

afterEach(() => {
	resetSharedConvexSubscriptions();
	vi.useRealTimers();
});

async function growTo(name: string, loadMore: () => void, steps: number) {
	fake.serverTick(name);
	for (let i = 0; i < steps; i += 1) {
		loadMore();
		await nextTick();
		vi.advanceTimersByTime(1_000);
		fake.serverTick(name);
	}
}

describe('growable-limit subscriptions', () => {
	it('chat 100 -> 500 leaves one live window, re-run once per write', async () => {
		const { useChatRoom } = await import('../chat/useChatRoom');
		const scope = effectScope();
		const room = scope.run(() => useChatRoom(ref('room1' as never)))!;
		await nextTick();

		await growTo(CHAT, room.loadMoreMessages, 4);

		expect(fake.wire.filter((w) => w.name === CHAT)).toHaveLength(5);
		expect(fake.live(CHAT).map((w) => w.args.limit)).toEqual([500]);
		const before = fake.executions();
		fake.serverTick(CHAT);
		expect(fake.executions() - before).toBe(1);

		// Leaving the room is a normal navigation: the last window stays warm.
		scope.stop();
		vi.advanceTimersByTime(SUBSCRIPTION_LINGER_MS - 1);
		expect(fake.live(CHAT)).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(fake.live(CHAT)).toHaveLength(0);
	});

	it('grouped Postbox 50 -> 500 leaves one live window', async () => {
		const { usePostboxThreadGroups } = await import('../postbox/usePostboxThreadGroups');
		const scope = effectScope();
		const groups = scope.run(() =>
			usePostboxThreadGroups({
				mailboxId: ref('mb1' as never),
				folderRole: ref('inbox'),
				enabled: ref(true),
			})
		)!;
		await nextTick();

		await growTo(THREADS, groups.loadMore, 9);

		expect(fake.wire.filter((w) => w.name === THREADS)).toHaveLength(10);
		expect(fake.live(THREADS).map((w) => w.args.limit)).toEqual([500]);
		// The previous window stayed on screen while the next one loaded.
		expect(groups.threads.value).toHaveLength(500);
		scope.stop();
	});

	it('a folder switch still lets the previous folder linger', async () => {
		const { usePostboxThreadGroups } = await import('../postbox/usePostboxThreadGroups');
		const folderRole = ref('inbox');
		const scope = effectScope();
		scope.run(() =>
			usePostboxThreadGroups({
				mailboxId: ref('mb1' as never),
				folderRole,
				enabled: ref(true),
			})
		);
		await nextTick();
		fake.serverTick(THREADS);

		folderRole.value = 'archive';
		await nextTick();

		expect(fake.live(THREADS).map((w) => w.args.folderRole)).toEqual(['inbox', 'archive']);
		vi.advanceTimersByTime(SUBSCRIPTION_LINGER_MS);
		expect(fake.live(THREADS).map((w) => w.args.folderRole)).toEqual(['archive']);
		scope.stop();
	});
});
