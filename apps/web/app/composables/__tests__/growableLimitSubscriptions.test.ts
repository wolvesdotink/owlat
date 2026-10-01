/**
 * The growable-limit lists (chat history, grouped Postbox, inbox sections) keep
 * the frame's first window and the current one live, not one window per size
 * they passed through (#924). The first window stays warm because a return to
 * the frame starts there again. Drives the real
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
const SECTIONS = 'mail/sections:listSections';

vi.mock('../postbox/usePostboxRoleFolderId', () => ({
	usePostboxRoleFolderId: () => ref(null),
}));

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
				name === CHAT
					? { messages: rows, hasMore: true }
					: name === SECTIONS
						? { sections: [] }
						: { threads: rows, hasMore: true };
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
	vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()));
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
	it('chat 100 -> 500 closes the intermediate windows and keeps page one warm', async () => {
		const { useChatRoom } = await import('../chat/useChatRoom');
		const scope = effectScope();
		const room = scope.run(() => useChatRoom(ref('room1' as never)))!;
		await nextTick();

		await growTo(CHAT, room.loadMoreMessages, 4);

		expect(fake.wire.filter((w) => w.name === CHAT)).toHaveLength(5);
		expect(fake.live(CHAT).map((w) => w.args.limit)).toEqual([100, 500]);
		const before = fake.executions();
		fake.serverTick(CHAT);
		expect(fake.executions() - before).toBe(2);

		// Page one was left at the first "Load earlier" (t = 0): it lingers the
		// usual time. Leaving the room lets the last window linger too.
		scope.stop();
		vi.advanceTimersByTime(SUBSCRIPTION_LINGER_MS - 4_000);
		expect(fake.live(CHAT).map((w) => w.args.limit)).toEqual([500]);
		vi.advanceTimersByTime(3_999);
		expect(fake.live(CHAT)).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(fake.live(CHAT)).toHaveLength(0);
	});

	it('returning to a room after expanding it reads page one warm', async () => {
		const { useChatRoom } = await import('../chat/useChatRoom');
		const roomId = ref('room1' as never);
		const scope = effectScope();
		const room = scope.run(() => useChatRoom(roomId))!;
		await nextTick();
		await growTo(CHAT, room.loadMoreMessages, 1);

		vi.advanceTimersByTime(5_000);
		roomId.value = 'room2' as never;
		await nextTick();
		fake.serverTick(CHAT);
		vi.advanceTimersByTime(5_000);

		const opened = fake.wire.length;
		roomId.value = 'room1' as never;
		await nextTick();

		expect(fake.wire).toHaveLength(opened);
		expect(room.messagesLoading.value).toBe(false);
		expect(room.messages.value).toHaveLength(100);
		scope.stop();
	});

	it('grouped Postbox 50 -> 500 closes the intermediate windows', async () => {
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
		expect(fake.live(THREADS).map((w) => w.args.limit)).toEqual([50, 500]);
		// The previous window stayed on screen while the next one loaded.
		expect(groups.threads.value).toHaveLength(500);
		scope.stop();
	});

	it('returning to an expanded folder shows its first page at once', async () => {
		const { usePostboxThreadGroups } = await import('../postbox/usePostboxThreadGroups');
		const folderRole = ref('inbox');
		const scope = effectScope();
		const groups = scope.run(() =>
			usePostboxThreadGroups({
				mailboxId: ref('mb1' as never),
				folderRole,
				enabled: ref(true),
			})
		)!;
		await nextTick();
		await growTo(THREADS, groups.loadMore, 1);

		folderRole.value = 'archive';
		await nextTick();
		fake.serverTick(THREADS);
		const opened = fake.wire.length;
		folderRole.value = 'inbox';
		await nextTick();

		expect(fake.wire).toHaveLength(opened);
		expect(groups.threads.value).toHaveLength(50);
		scope.stop();
	});

	it('inbox sections close the window a section grew out of', async () => {
		const { usePostboxThreadSections } = await import('../postbox/usePostboxThreadSections');
		const mailboxId = ref('mb1' as never);
		const scope = effectScope();
		const view = scope.run(() => usePostboxThreadSections({ mailboxId, enabled: ref(true) }))!;
		await nextTick();
		fake.serverTick(SECTIONS);
		const limitsOf = () => fake.live(SECTIONS).map((w) => JSON.stringify(w.args.limits));

		for (let i = 0; i < 3; i += 1) {
			view.loadMore('news');
			await nextTick();
			fake.serverTick(SECTIONS);
		}
		expect(fake.wire.filter((w) => w.name === SECTIONS)).toHaveLength(4);
		expect(limitsOf()).toEqual(['[]', '[{"section":"news","limit":80}]']);

		// Another mailbox is a leave: the grown window lingers.
		mailboxId.value = 'mb2' as never;
		await nextTick();
		expect(fake.live(SECTIONS).map((w) => w.args.mailboxId)).toEqual(['mb1', 'mb1', 'mb2']);
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
