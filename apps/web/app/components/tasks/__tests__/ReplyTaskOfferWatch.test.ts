/**
 * A held reply offers its conversation's tasks only once the server records a
 * send that reached the recipient, and exactly once. The end of the undo
 * window proves nothing: a dispatch refused after it (a blocked recipient, no
 * sender identity), a transport failure, an Undo, or a reply that never
 * settles all release the hold with no offer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, ref, type Ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { api } from '@owlat/api';

const offer = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('~/composables/useReplyTaskOffer', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	useReplyTaskOffer: () => ({ offer }),
}));

import {
	clearReplyTaskHolds,
	holdMailReplyOffer,
	holdTeamReplyOffer,
	useReplyTaskHolds,
	type ReplyTaskHold,
} from '~/composables/useReplyTaskOffer';
import ReplyTaskOfferWatch from '../ReplyTaskOfferWatch.vue';

let data: Record<string, Ref<unknown>>;
let args: Record<string, unknown>;
const name = (fn: unknown) => getFunctionName(fn as FunctionReference<'query'>);

beforeEach(() => {
	clearReplyTaskHolds();
	offer.mockClear();
	data = {};
	args = {};
	vi.stubGlobal('useConvexQuery', (query: unknown, getArgs: () => unknown) => {
		const key = name(query);
		args[key] = getArgs();
		data[key] ??= ref(undefined);
		return { data: data[key] };
	});
});

let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
	vi.useRealTimers();
});

const DRAFT = name(api.mail.drafts.get);
const DELIVERY = name(api.mail.mailbox.messages.listThreadOutboundDelivery);
const THREAD = name(api.inbox.queries.getThread);
const FOLLOW_UPS = name(api.inbox.followUps.listForThread);

async function set(key: string, value: unknown) {
	data[key]!.value = value;
	await nextTick();
	await flushPromises();
}

function watchHold(): ReplyTaskHold {
	const hold = useReplyTaskHolds().value[0]!;
	wrapper = mount(ReplyTaskOfferWatch, { props: { hold } });
	return hold;
}

const outbound = (messageId: string, state: string) => ({
	messageId,
	state,
	recipients: [{ idx: 0, address: 'jonas@example.com', state }],
});
const held = () => useReplyTaskHolds().value.length;

function holdMail() {
	holdMailReplyOffer(
		{ scheduled: false, queuedOffline: false },
		{ draftId: 'd1', threadMessageId: 'm_in', mailThreadId: 'thread_1' }
	);
	return watchHold();
}

describe('ReplyTaskOfferWatch, a Postbox reply', () => {
	it('offers once the filed message reached its recipient, and never twice', async () => {
		const hold = holdMail();
		expect(args[DRAFT]).toEqual({ draftId: 'd1' });
		expect(args[DELIVERY]).toEqual({ messageId: 'm_in' });
		await set(DRAFT, { state: 'pending_send' });
		await set(DELIVERY, [outbound('m_old', 'sent')]);
		// The window closed and the send filed the message: not sent yet.
		await set(DRAFT, null);
		await set(DELIVERY, [outbound('m_old', 'sent'), outbound('m_new', 'queued')]);
		expect(offer).not.toHaveBeenCalled();
		expect(held()).toBe(1);

		await set(DELIVERY, [outbound('m_old', 'sent'), outbound('m_new', 'sent')]);
		expect(offer).toHaveBeenCalledExactlyOnceWith(hold.target);
		expect(held()).toBe(0);
		await set(DELIVERY, [
			outbound('m_old', 'sent'),
			outbound('m_new', 'sent'),
			outbound('x', 'sent'),
		]);
		expect(offer).toHaveBeenCalledOnce();
	});

	it('offers nothing when the dispatch is refused after the window and the draft comes back', async () => {
		holdMail();
		await set(DELIVERY, []);
		await set(DRAFT, { state: 'pending_send' });
		await set(DRAFT, { state: 'draft' });
		expect(offer).not.toHaveBeenCalled();
		expect(held()).toBe(0);
	});

	it('offers nothing when the transport fails the filed message', async () => {
		holdMail();
		await set(DELIVERY, []);
		await set(DRAFT, { state: 'pending_send' });
		await set(DRAFT, null);
		await set(DELIVERY, [outbound('m_new', 'failed')]);
		expect(offer).not.toHaveBeenCalled();
		expect(held()).toBe(0);
	});

	it('gives up on a reply that never settles, and offers nothing', async () => {
		vi.useFakeTimers();
		holdMail();
		await set(DRAFT, { state: 'pending_send' });
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(offer).not.toHaveBeenCalled();
		expect(held()).toBe(0);
	});
});

describe('ReplyTaskOfferWatch, a team reply', () => {
	const message = (processingStatus: string) => ({
		thread: {},
		messages: [{ _id: 'in_1', processingStatus }],
	});

	it('offers once an approve held in its window reaches sent', async () => {
		holdTeamReplyOffer({ kind: 'reply', messageId: 'in_1', sendAt: 5 }, 'conv_1' as never);
		watchHold();
		expect(args[THREAD]).toEqual({ threadId: 'conv_1' });
		await set(THREAD, message('approved'));
		expect(offer).not.toHaveBeenCalled();
		await set(THREAD, message('sent'));
		expect(offer).toHaveBeenCalledExactlyOnceWith({ conversationThreadId: 'conv_1' });
	});

	it('offers nothing for an approve with no window whose Send fails', async () => {
		holdTeamReplyOffer({ kind: 'reply', messageId: 'in_1' }, 'conv_1' as never);
		watchHold();
		await set(THREAD, message('approved'));
		await set(THREAD, message('draft_ready'));
		expect(offer).not.toHaveBeenCalled();
		expect(held()).toBe(0);
	});

	it('offers nothing for a follow-up refused at dispatch, and once for one sent', async () => {
		holdTeamReplyOffer({ kind: 'followUp', followUpId: 'fu_1', sendAt: 9 }, 'conv_1' as never);
		watchHold();
		expect(args[FOLLOW_UPS]).toEqual({ threadId: 'conv_1' });
		await set(FOLLOW_UPS, [{ _id: 'fu_1', status: 'scheduled' }]);
		await set(FOLLOW_UPS, [{ _id: 'fu_1', status: 'failed' }]);
		expect(offer).not.toHaveBeenCalled();
		expect(held()).toBe(0);
		wrapper!.unmount();
		data[FOLLOW_UPS]!.value = undefined;

		holdTeamReplyOffer({ kind: 'followUp', followUpId: 'fu_2' }, 'conv_1' as never);
		watchHold();
		await set(FOLLOW_UPS, [{ _id: 'fu_2', status: 'sending' }]);
		await set(FOLLOW_UPS, [{ _id: 'fu_2', status: 'sent' }]);
		expect(offer).toHaveBeenCalledOnce();
	});
});
