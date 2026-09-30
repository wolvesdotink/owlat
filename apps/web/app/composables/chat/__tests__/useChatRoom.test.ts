// @vitest-environment happy-dom
/**
 * `useChatRoom` against a fake subscription transport that behaves like the
 * backend: `markRead` moves the member's `lastReadAt` forward, and `getRoom`
 * re-emits the room with the new `myLastReadAt` — the feedback path that used
 * to acknowledge itself on every tick (#944).
 *
 * The send path (#945) must hand the operation's `{ ok }` back to the
 * composer, so a refused send can keep the draft.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope, type Ref } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { getFunctionName } from 'convex/server';
import { api } from '@owlat/api';

import { createTestI18n } from '~/__tests__/i18n';
import { useGrowableLimit } from '~/composables/postbox/useGrowableLimit';

// Outside a component `useI18n` would throw; the real catalog's `t` stands in.
const { t } = createTestI18n().global;

const ROOM_A = 'room_a';
const ROOM_B = 'room_b';

const fn = (reference: unknown) => getFunctionName(reference as never);
const GET_ROOM = fn(api.chat.rooms.getRoom);
const LIST_MESSAGES = fn(api.chat.messages.listMessages);
const MARK_READ = fn(api.chat.messages.markRead);
const SEND_MESSAGE = fn(api.chat.messages.sendMessage);

type FakeRoom = { _id: string; name: string; isMember: boolean; myLastReadAt: number };
type FakeMessage = { _id: string; roomId: string; createdAt: number; text: string };

// Server state, per room.
let rooms: Record<string, FakeRoom>;
let roomMessages: Record<string, FakeMessage[]>;
// What the live subscriptions currently hold.
let roomData: Ref<FakeRoom | undefined>;
let messagesData: Ref<{ messages: FakeMessage[]; hasMore: boolean } | undefined>;
let markReadCalls: { roomId: string; at?: number }[];
let markReadOutcome: () => { ok: boolean };
let sendOutcome: () => { ok: boolean; result?: string };
let sendCalls: unknown[];
let clock: number;
let visibility: DocumentVisibilityState;
let scope: EffectScope | null = null;

function setVisibility(state: DocumentVisibilityState) {
	visibility = state;
	document.dispatchEvent(new Event('visibilitychange'));
}

/** Push the server state of `roomId` through both subscriptions. */
function emitRoom(roomId: string) {
	roomData.value = { ...rooms[roomId]! };
	messagesData.value = { messages: [...roomMessages[roomId]!], hasMore: false };
}

function addMessage(roomId: string, id: string) {
	clock += 1000;
	roomMessages[roomId]!.push({ _id: id, roomId, createdAt: clock, text: id });
}

/** Mirrors `chat.messages.markRead`: only a later timestamp moves the marker. */
async function fakeMarkRead(args: { roomId: string; at?: number }) {
	markReadCalls.push(args);
	// A runaway loop would never settle; stop feeding it back after a handful.
	if (markReadCalls.length > 8) return { ok: true, result: null };
	await Promise.resolve();
	const outcome = markReadOutcome();
	if (!outcome.ok) return { ok: false };
	clock += 7;
	const at = args.at ?? clock;
	const room = rooms[args.roomId]!;
	if (at > room.myLastReadAt) {
		room.myLastReadAt = at;
		// getRoom reads the membership, so the patch re-emits the room.
		if (roomData.value?._id === args.roomId) roomData.value = { ...room };
	}
	return { ok: true, result: null };
}

beforeEach(() => {
	clock = Date.UTC(2026, 9, 1, 12);
	rooms = {
		[ROOM_A]: { _id: ROOM_A, name: 'general', isMember: true, myLastReadAt: clock - 60_000 },
		[ROOM_B]: { _id: ROOM_B, name: 'random', isMember: true, myLastReadAt: clock - 60_000 },
	};
	roomMessages = { [ROOM_A]: [], [ROOM_B]: [] };
	addMessage(ROOM_A, 'a1');
	addMessage(ROOM_A, 'a2');
	addMessage(ROOM_B, 'b1');
	roomData = ref();
	messagesData = ref();
	markReadCalls = [];
	markReadOutcome = () => ({ ok: true });
	sendOutcome = () => ({ ok: true, result: 'msg_new' });
	sendCalls = [];
	visibility = 'visible';
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		get: () => visibility,
	});

	vi.stubGlobal('useI18n', () => ({ t }));
	vi.stubGlobal('useGrowableLimit', useGrowableLimit);
	vi.stubGlobal('useConvexQuery', (query: unknown) => {
		const name = fn(query);
		if (name === GET_ROOM) return { data: roomData, isLoading: ref(false) };
		if (name === LIST_MESSAGES) return { data: messagesData, isLoading: ref(false) };
		return { data: ref(undefined), isLoading: ref(false) };
	});
	vi.stubGlobal('useBackendOperation', (operation: unknown) => {
		const name = fn(operation);
		const run = async (args: never) => {
			if (name === MARK_READ) return await fakeMarkRead(args);
			if (name === SEND_MESSAGE) {
				sendCalls.push(args);
				return sendOutcome();
			}
			return { ok: true, result: null };
		};
		return { run, isLoading: ref(false), inlineError: ref(null) };
	});
});

afterEach(() => {
	scope?.stop();
	scope = null;
});

async function settle() {
	for (let i = 0; i < 12; i++) {
		await flushPromises();
		await nextTick();
	}
}

async function open(initial = ROOM_A) {
	const { useChatRoom } = await import('../useChatRoom');
	const roomId = ref<string | undefined>(initial);
	scope = effectScope();
	const chat = scope.run(() => useChatRoom(roomId as never))!;
	emitRoom(initial);
	await settle();
	return { chat, roomId };
}

const latestAt = (roomId: string) => roomMessages[roomId]!.at(-1)!.createdAt;

describe('useChatRoom read acknowledgement (#944)', () => {
	it('acknowledges an opened room once, then stays quiet while nothing new is shown', async () => {
		await open();

		expect(markReadCalls).toEqual([{ roomId: ROOM_A, at: latestAt(ROOM_A) }]);
		// The write's own myLastReadAt emission landed and did not trigger another.
		expect(rooms[ROOM_A]!.myLastReadAt).toBe(latestAt(ROOM_A));

		// Metadata and membership re-emissions are not new messages either.
		roomData.value = { ...rooms[ROOM_A]!, name: 'general-renamed' };
		await settle();
		roomData.value = { ...rooms[ROOM_A]!, myLastReadAt: rooms[ROOM_A]!.myLastReadAt };
		await settle();
		expect(markReadCalls).toHaveLength(1);
	});

	it('acknowledges the displayed message, never the wall clock', async () => {
		await open();
		// The fake clock ran past the message while the round trip was in flight;
		// the acknowledgement still covers only what was on screen.
		expect(clock).toBeGreaterThan(latestAt(ROOM_A));
		expect(markReadCalls[0]!.at).toBe(latestAt(ROOM_A));

		// A message created after that snapshot stays unread.
		addMessage(ROOM_A, 'a3-not-yet-shown');
		expect(roomMessages[ROOM_A]!.at(-1)!.createdAt).toBeGreaterThan(rooms[ROOM_A]!.myLastReadAt);
	});

	it('advances the marker once per newly displayed message', async () => {
		await open();

		addMessage(ROOM_A, 'a3');
		emitRoom(ROOM_A);
		await settle();

		expect(markReadCalls).toEqual([
			{ roomId: ROOM_A, at: roomMessages[ROOM_A]![1]!.createdAt },
			{ roomId: ROOM_A, at: latestAt(ROOM_A) },
		]);

		// An edit to a shown message changes the list but not the newest point.
		roomMessages[ROOM_A]![2]!.text = 'a3 (edited)';
		emitRoom(ROOM_A);
		await settle();
		expect(markReadCalls).toHaveLength(2);
	});

	it('leaves messages unread in a hidden tab and acknowledges them on return', async () => {
		await open();
		setVisibility('hidden');

		addMessage(ROOM_A, 'a3');
		emitRoom(ROOM_A);
		await settle();
		expect(markReadCalls).toHaveLength(1);
		expect(rooms[ROOM_A]!.myLastReadAt).toBeLessThan(latestAt(ROOM_A));

		setVisibility('visible');
		await settle();
		expect(markReadCalls).toHaveLength(2);
		expect(markReadCalls[1]).toEqual({ roomId: ROOM_A, at: latestAt(ROOM_A) });
	});

	it('does not acknowledge a room opened while the tab is hidden until it is shown', async () => {
		visibility = 'hidden';
		await open();
		expect(markReadCalls).toHaveLength(0);

		setVisibility('visible');
		await settle();
		expect(markReadCalls).toEqual([{ roomId: ROOM_A, at: latestAt(ROOM_A) }]);
	});

	it('never acknowledges a room the caller is not a member of', async () => {
		rooms[ROOM_A]!.isMember = false;
		await open();
		expect(markReadCalls).toHaveLength(0);
	});

	it('does not acknowledge the next room with the previous room messages', async () => {
		const { roomId } = await open();
		expect(markReadCalls).toHaveLength(1);

		// The route moves on; the room subscription answers before the message
		// list does, so the list still holds room A's messages for a moment.
		roomId.value = ROOM_B;
		roomData.value = { ...rooms[ROOM_B]! };
		await settle();
		expect(markReadCalls).toHaveLength(1);

		messagesData.value = { messages: [...roomMessages[ROOM_B]!], hasMore: false };
		await settle();
		expect(markReadCalls).toEqual([
			{ roomId: ROOM_A, at: latestAt(ROOM_A) },
			{ roomId: ROOM_B, at: latestAt(ROOM_B) },
		]);
	});

	it('does not retry a failed acknowledgement in a loop, but tries again on the next message', async () => {
		markReadOutcome = () => ({ ok: false });
		await open();
		roomData.value = { ...rooms[ROOM_A]! };
		await settle();
		expect(markReadCalls).toHaveLength(1);

		markReadOutcome = () => ({ ok: true });
		addMessage(ROOM_A, 'a3');
		emitRoom(ROOM_A);
		await settle();
		expect(markReadCalls).toHaveLength(2);
		expect(rooms[ROOM_A]!.myLastReadAt).toBe(latestAt(ROOM_A));
	});

	it('retries a failed acknowledgement when the tab comes back', async () => {
		markReadOutcome = () => ({ ok: false });
		await open();
		expect(markReadCalls).toHaveLength(1);

		markReadOutcome = () => ({ ok: true });
		setVisibility('hidden');
		await settle();
		expect(markReadCalls).toHaveLength(1);
		setVisibility('visible');
		await settle();
		expect(markReadCalls).toHaveLength(2);
		expect(rooms[ROOM_A]!.myLastReadAt).toBe(latestAt(ROOM_A));
	});
});
