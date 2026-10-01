/**
 * usePostboxReaderComposer: every reply verb of the reader opens Answer mode.
 *
 *   - the keyboard paths (`r` / `a` against the thread's latest message) run
 *     through the sender-auth reply guard (Sealed Mail A3) before anything
 *     opens; forward never does;
 *   - `r` opens the person's primary reply kind, `a` a reply-all, `f` a
 *     forward, each as `/dashboard/answer/m/<id>?kind=…`;
 *   - an AI-suggested body is saved into a new draft first, and Answer mode
 *     opens on that draft (`?draft=`); if the draft cannot be created, the
 *     body waits in session state for Answer mode to pick up;
 *   - the resend (not a reply) still opens a popup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, computed, effectScope } from 'vue';

const composerOpen = vi.fn();
const navigateTo = vi.fn();
let state: Map<string, ReturnType<typeof ref>>;
let createResult: { ok: boolean; result?: { draftId: string } };
const mutations: Array<{ op: string; args: unknown }> = [];

vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
vi.stubGlobal('usePostboxComposerStack', () => ({ open: composerOpen }));
vi.stubGlobal('useState', (key: string, init: () => unknown) => {
	if (!state.has(key)) state.set(key, ref(init()));
	return state.get(key);
});
vi.stubGlobal('useRouter', () => ({
	currentRoute: ref({
		path: '/dashboard/postbox/inbox/msg_1',
		fullPath: '/dashboard/postbox/inbox/msg_1',
	}),
}));
vi.stubGlobal('navigateTo', navigateTo);
// Two operations in declaration order: drafts.create, then drafts.update.
let operationIndex = 0;
vi.stubGlobal('useBackendOperation', () => {
	const op = operationIndex++ % 2 === 0 ? 'create' : 'update';
	return {
		run: async (args: unknown) => {
			mutations.push({ op, args });
			return op === 'create' ? createResult : { ok: true, result: {} };
		},
	};
});
vi.mock('@owlat/api', () => ({ api: { mail: { drafts: { create: {}, update: {} } } } }));
vi.mock('../usePostboxQuotedText', () => ({
	resolveBodyFields: async (source: unknown) => source,
	buildReplySpec: (mailboxId: string, target: { _id: string; fromAddress: string }, lead = '') => ({
		mailboxId,
		inReplyToMessageId: target._id,
		prefillTo: [target.fromAddress],
		prefillSubject: 'Re: Hi',
		prefillBodyHtml: `<p>${lead}</p><div class="gmail_quote">quote</div>`,
	}),
	buildForwardedBody: () => '',
	buildResendSpec: (mailboxId: string, _t: unknown, to: string[]) => ({ mailboxId, prefillTo: to }),
}));

import { usePostboxReaderComposer } from '../usePostboxReaderComposer';
import { useAnswerPendingLead } from '~/composables/useAnswerMode';

const message = {
	_id: 'msg_1',
	mailboxId: 'mbx_1',
	threadId: 'thr_1',
	subject: 'Hi',
	fromAddress: 'sender@example.com',
	fromName: 'Sender',
	toAddresses: ['me@example.com', 'colleague@example.com'],
	ccAddresses: [],
	receivedAt: 0,
};

function makeComposer(guardReply: (run: () => void) => void, replyDefault = 'reply') {
	const scope = effectScope();
	return scope.run(() =>
		usePostboxReaderComposer({
			getMessage: () => message,
			latestMessage: computed(() => message),
			ownAddresses: computed(() => new Set<string>(['me@example.com'])),
			replyDefault: ref(replyDefault as 'reply' | 'reply-all'),
			guardReply,
		})
	)!;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
	state = new Map();
	composerOpen.mockClear();
	navigateTo.mockClear();
	mutations.length = 0;
	operationIndex = 0;
	createResult = { ok: true, result: { draftId: 'draft_9' } };
});

describe('usePostboxReaderComposer', () => {
	it('guards `r`, then opens Answer mode with the primary reply kind', () => {
		const guardReply = vi.fn();
		const { replyToLatest } = makeComposer(guardReply);

		replyToLatest();
		expect(guardReply).toHaveBeenCalledTimes(1);
		// Nothing opens until the guard lets the reply through.
		expect(navigateTo).not.toHaveBeenCalled();

		guardReply.mock.calls[0]![0]!();
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/answer/m/msg_1?kind=reply');
	});

	it('opens a reply-all for `r` when that is the default and it adds someone', () => {
		const { replyToLatest } = makeComposer((run) => run(), 'reply-all');
		replyToLatest();
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/answer/m/msg_1?kind=replyAll');
	});

	it('guards `a` too, and never guards forward', () => {
		const guardReply = vi.fn((run: () => void) => run());
		const { replyAllToLatest, forwardLatest } = makeComposer(guardReply);

		replyAllToLatest();
		expect(guardReply).toHaveBeenCalledTimes(1);
		expect(navigateTo).toHaveBeenLastCalledWith('/dashboard/answer/m/msg_1?kind=replyAll');

		guardReply.mockClear();
		forwardLatest();
		expect(guardReply).not.toHaveBeenCalled();
		expect(navigateTo).toHaveBeenLastCalledWith('/dashboard/answer/m/msg_1?kind=forward');
	});

	it('remembers where the reply started, for Esc', () => {
		const { openForward } = makeComposer((run) => run());
		openForward();
		expect(state.get('answer:return-to')?.value).toBe('/dashboard/postbox/inbox/msg_1');
	});

	it('saves an AI-suggested body into a draft before opening it in Answer mode', async () => {
		const { openReplyWithBody } = makeComposer((run) => run());
		await openReplyWithBody(message, 'Tuesday works');
		await flush();

		expect(mutations.map((m) => m.op)).toEqual(['create', 'update']);
		expect(mutations[0]!.args).toEqual({ mailboxId: 'mbx_1', inReplyToMessageId: 'msg_1' });
		expect(mutations[1]!.args).toMatchObject({
			draftId: 'draft_9',
			toAddresses: ['sender@example.com'],
			subject: 'Re: Hi',
		});
		expect((mutations[1]!.args as { bodyHtml: string }).bodyHtml).toContain('Tuesday works');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/answer/m/msg_1?kind=reply&draft=draft_9');
	});

	it('keeps the suggestion for Answer mode when the draft cannot be created', async () => {
		createResult = { ok: false };
		const { openReplyWithBody } = makeComposer((run) => run());
		await openReplyWithBody(message, 'Tuesday works');

		expect(navigateTo).toHaveBeenCalledWith('/dashboard/answer/m/msg_1?kind=reply');
		expect(useAnswerPendingLead().take('msg_1')).toBe('Tuesday works');
	});

	it('keeps the resend (not a reply) in a popup', async () => {
		const { openResend } = makeComposer((run) => run());
		await openResend(message, ['bounced@example.com']);
		expect(composerOpen).toHaveBeenCalledWith({
			mailboxId: 'mbx_1',
			prefillTo: ['bounced@example.com'],
		});
		expect(navigateTo).not.toHaveBeenCalled();
	});
});
