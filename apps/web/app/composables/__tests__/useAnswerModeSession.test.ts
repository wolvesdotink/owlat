// @vitest-environment happy-dom
/**
 * What Answer mode opens its composer with, from the URL alone:
 *   - `?draft=` resumes the draft (no guard: it was answered when it began);
 *   - `?kind=` opens that composer; no kind opens the primary reply;
 *   - replies pass the sender-auth guard first, forwards never do;
 *   - nothing opens before the mailbox's own addresses are known (reply-all
 *     math), unless reading them failed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';

let state: Map<string, ReturnType<typeof ref>>;
const ownData = ref<string[] | undefined>(undefined);
const ownError = ref<unknown>(null);
const replyDefault = ref<'reply' | 'reply-all'>('reply');

vi.stubGlobal('useState', (key: string, init: () => unknown) => {
	if (!state.has(key)) state.set(key, ref(init()));
	return state.get(key);
});
vi.stubGlobal('useConvexQuery', () => ({ data: ownData, error: ownError }));
vi.stubGlobal('usePostboxSettings', () => ({ replyDefault }));
vi.mock('@owlat/api', () => ({ api: { mail: { identities: { listForOwnedMailbox: {} } } } }));
vi.mock('~/composables/postbox/postboxBodyResolver', () => ({
	consumeResolvedPostboxMessageBody: async () => null,
}));

import { useAnswerModeSession, type AnswerModeMessage } from '../useAnswerModeSession';
import { useAnswerPendingLead } from '../useAnswerMode';
import type { AnswerModeKind } from '~/utils/answerMode';

const message: AnswerModeMessage = {
	_id: 'msg_1',
	mailboxId: 'mbx_1',
	threadId: 'thr_1',
	subject: 'September invoice',
	fromAddress: 'jonas@example.com',
	fromName: 'Jonas',
	toAddresses: ['ada@example.com', 'finance@example.com'],
	ccAddresses: [],
	receivedAt: Date.UTC(2026, 8, 30, 9, 14),
	textBodyInline: 'Could you send the invoice?',
};

function start(opts: { draftId?: string | null; kind?: AnswerModeKind | null }) {
	const guard = vi.fn((_m: AnswerModeMessage, proceed: () => void) => proceed());
	const msg = ref<AnswerModeMessage | undefined>(message);
	const session = effectScope().run(() =>
		useAnswerModeSession({
			message: () => msg.value,
			draftId: opts.draftId ?? null,
			kind: opts.kind ?? null,
			guard,
		})
	)!;
	return { ...session, guard, msg };
}

const settle = async () => {
	await nextTick();
	await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
	state = new Map();
	ownData.value = ['ada@example.com'];
	ownError.value = null;
	replyDefault.value = 'reply';
});

describe('useAnswerModeSession', () => {
	it('resumes ?draft= as the draft itself, without asking the guard again', async () => {
		const { seed, guard } = start({ draftId: 'd_1', kind: 'replyAll' });
		await settle();
		expect(seed.value).toEqual({
			mailboxId: 'mbx_1',
			draftId: 'd_1',
			inReplyToMessageId: 'msg_1',
		});
		expect(guard).not.toHaveBeenCalled();
	});

	it('does not thread a resumed forward under the message', async () => {
		const { seed } = start({ draftId: 'd_1', kind: 'forward' });
		await settle();
		expect(seed.value).toEqual({ mailboxId: 'mbx_1', draftId: 'd_1' });
	});

	it('opens a fresh reply, quoted and addressed, behind the guard', async () => {
		const { seed, guard, kind } = start({ kind: 'reply' });
		await settle();
		expect(guard).toHaveBeenCalledTimes(1);
		expect(kind.value).toBe('reply');
		expect(seed.value).toMatchObject({
			mailboxId: 'mbx_1',
			inReplyToMessageId: 'msg_1',
			prefillTo: ['jonas@example.com'],
			prefillSubject: 'Re: September invoice',
			// The plain reply leaves finance@ out; the composer offers "Reply all".
			replyAllRecipients: ['finance@example.com'],
		});
		expect(seed.value?.prefillBodyHtml).toContain('gmail_quote');
	});

	it('opens a forward without the guard', async () => {
		const { seed, guard } = start({ kind: 'forward' });
		await settle();
		expect(guard).not.toHaveBeenCalled();
		expect(seed.value?.prefillSubject).toBe('Fwd: September invoice');
		expect(seed.value?.forwardAttachmentsFromMessageId).toBe('msg_1');
	});

	it('resolves no kind to the primary reply (the default reply mode)', async () => {
		replyDefault.value = 'reply-all';
		const { seed, kind } = start({});
		await settle();
		expect(kind.value).toBe('replyAll');
		expect(seed.value?.prefillCc).toEqual(['finance@example.com']);
	});

	it('opens nothing when the guard is cancelled', async () => {
		const guard = vi.fn();
		const session = effectScope().run(() =>
			useAnswerModeSession({ message: () => message, draftId: null, kind: 'reply', guard })
		)!;
		await settle();
		expect(guard).toHaveBeenCalledTimes(1);
		expect(session.seed.value).toBeNull();
	});

	it('waits for the mailbox addresses, unless reading them failed', async () => {
		ownData.value = undefined;
		const { seed } = start({ kind: 'reply' });
		await settle();
		expect(seed.value).toBeNull();

		ownError.value = new Error('offline');
		await settle();
		expect(seed.value?.prefillTo).toEqual(['jonas@example.com']);
	});

	it('puts a pending AI body above the quote', async () => {
		useAnswerPendingLead().set('msg_1', 'Here it is');
		const { seed } = start({ kind: 'reply' });
		await settle();
		expect(seed.value?.prefillBodyHtml?.startsWith('<p>Here it is</p>')).toBe(true);
	});
});
