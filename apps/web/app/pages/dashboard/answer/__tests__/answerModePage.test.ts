// @vitest-environment happy-dom
/**
 * /dashboard/answer/m/<messageId>: the URL is the state.
 *
 *   - `?draft=` resumes that draft; `?kind=` opens that composer; no kind opens
 *     the primary reply;
 *   - the composer's first autosave writes the draft id into the URL with a
 *     REPLACE, so Back still leaves Answer mode and a reload lands here again;
 *   - Esc leaves (the draft stays saved and is offered back on the list),
 *     `t` toggles Summary / Full, Cmd/Ctrl+J focuses "Draft with AI";
 *   - a send goes back where the reply started.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, reactive, ref, computed, useId, shallowRef } from 'vue';

import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import AnswerModeFrame from '~/components/answer/AnswerModeFrame.vue';
import { useAnswerAiFocus, useAnswerLeftDraft } from '~/composables/useAnswerMode';
import AnswerPage from '../m/[messageId].vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});
vi.mock('~/composables/postbox/postboxBodyResolver', () => ({
	consumeResolvedPostboxMessageBody: async () => null,
}));

const message = {
	_id: 'msg_1',
	mailboxId: 'mbx_1',
	threadId: 'thr_1',
	subject: 'September invoice',
	fromAddress: 'jonas@example.com',
	fromName: 'Jonas Berg',
	toAddresses: ['ada@example.com'],
	ccAddresses: [],
	receivedAt: Date.UTC(2026, 8, 30, 9, 14),
	textBodyInline: 'Could you send the invoice?',
	hasAttachments: false,
	attachments: [],
};

const route = reactive({
	path: '/dashboard/answer/m/msg_1',
	fullPath: '/dashboard/answer/m/msg_1',
	params: { messageId: 'msg_1' } as Record<string, string>,
	query: {} as Record<string, string>,
	meta: {},
});
const routerReplace = vi.fn();
const navigateTo = vi.fn();
let state: Map<string, ReturnType<typeof ref>>;
let capturedMeta: Record<string, unknown> = {};

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useId,
		useHead: () => {},
		definePageMeta: (meta: Record<string, unknown>) => {
			capturedMeta = meta;
		},
		useRoute: () => route,
		useRouter: () => ({
			replace: routerReplace,
			back: vi.fn(),
			currentRoute: computed(() => route),
		}),
		navigateTo,
		useState: (key: string, init: () => unknown) => {
			if (!state.has(key)) state.set(key, ref(init()));
			return state.get(key);
		},
		usePostboxActiveMessage: () => computed(() => message),
		useConvexQuery: () => ({ data: ref(['ada@example.com']), error: ref(null) }),
		usePostboxSettings: () => ({ replyDefault: ref('reply') }),
		useFeatureFlag: () => ({ isEnabled: () => false }),
		useInboxes: () => ({
			byId: ref(new Map([['mbx_1', { name: 'Ada', slot: 0, address: 'ada@example.com' }]])),
		}),
	});
});

/** The composer as the page sees it: its seed, and a snapshot it can be asked for. */
const composerSnapshot = shallowRef({
	draftId: null as string | null,
	toAddresses: [] as string[],
	hasContent: false,
});
const composerFlush = vi.fn(async () => 'draft_saved');
const ComposerStub = defineComponent({
	name: 'PostboxComposer',
	props: ['seed', 'replyAllRecipients', 'frame'],
	emits: ['draft-id', 'sent', 'discarded', 'minimize'],
	setup(_p, { expose }) {
		expose({
			focusBody: vi.fn(),
			flush: composerFlush,
			snapshot: () => composerSnapshot.value,
		});
		return () => h('div', { 'data-testid': 'composer' });
	},
});
const ConversationStub = defineComponent({
	name: 'AnswerConversation',
	props: ['message', 'view'],
	emits: ['update:view', 'count'],
	setup: (props) => () => h('div', { 'data-testid': 'conversation', 'data-view': props.view }),
});
const guardCalls: string[] = [];
const GuardStub = defineComponent({
	name: 'PostboxReplyGuard',
	emits: ['cancel'],
	setup(_p, { expose }) {
		expose({
			guard: (threadId: string, _risk: unknown, _to: string, run: () => void) => {
				guardCalls.push(threadId);
				run();
			},
		});
		return () => h('div');
	},
});
const passThrough = (name: string) =>
	defineComponent({
		name,
		setup:
			(_p, { slots }) =>
			() =>
				h('div', slots.default?.({ close: () => {} })),
	});
const inert = (name: string) => defineComponent({ name, setup: () => () => h('div') });

let wrapper: VueWrapper | null = null;

async function mountAt(query: Record<string, string>) {
	route.query = query;
	route.fullPath = `/dashboard/answer/m/msg_1${Object.keys(query).length ? '?' + new URLSearchParams(query) : ''}`;
	wrapper = mount(AnswerPage, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: {
				AnswerModeFrame,
				AnswerConversation: ConversationStub,
				PostboxComposer: ComposerStub,
				PostboxReplyGuard: GuardStub,
				PostboxOverflowMenu: passThrough('PostboxOverflowMenu'),
				InboxChip: inert('InboxChip'),
				PostboxReaderSkeleton: inert('PostboxReaderSkeleton'),
				UiSkeleton: inert('UiSkeleton'),
			},
			stubs: { Icon: true },
		},
	});
	await flushPromises();
	return wrapper;
}

const seedOf = (w: VueWrapper) =>
	w.getComponent(ComposerStub).props('seed') as Record<string, unknown>;
const press = (init: KeyboardEventInit) =>
	window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

beforeEach(() => {
	state = new Map();
	routerReplace.mockClear();
	navigateTo.mockClear();
	composerFlush.mockClear();
	guardCalls.length = 0;
	composerSnapshot.value = { draftId: null, toAddresses: [], hasContent: false };
});

afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

describe('Answer mode page', () => {
	it('is Answer mode: the layout hides the shell for it', async () => {
		await mountAt({});
		expect(capturedMeta).toMatchObject({ layout: 'dashboard', answerMode: true });
	});

	it('resumes ?draft= as that draft, without the guard', async () => {
		const w = await mountAt({ draft: 'draft_1' });
		expect(seedOf(w)).toEqual({
			mailboxId: 'mbx_1',
			draftId: 'draft_1',
			inReplyToMessageId: 'msg_1',
		});
		expect(w.getComponent(ComposerStub).props('frame')).toBe('answer');
		expect(guardCalls).toEqual([]);
	});

	it('opens ?kind=forward as a forward', async () => {
		const w = await mountAt({ kind: 'forward' });
		expect(seedOf(w)).toMatchObject({ prefillSubject: 'Fwd: September invoice' });
		expect(guardCalls).toEqual([]);
	});

	it('opens a reply behind the guard when no kind is named', async () => {
		const w = await mountAt({});
		expect(guardCalls).toEqual(['thr_1']);
		expect(seedOf(w)).toMatchObject({
			inReplyToMessageId: 'msg_1',
			prefillTo: ['jonas@example.com'],
			prefillSubject: 'Re: September invoice',
		});
	});

	it('writes the new draft id into the URL with a replace, keeping the kind', async () => {
		const w = await mountAt({});
		w.getComponent(ComposerStub).vm.$emit('draft-id', 'draft_new');
		expect(routerReplace).toHaveBeenCalledWith({ query: { kind: 'reply', draft: 'draft_new' } });
		// The URL already naming the draft is left alone.
		route.query = { kind: 'reply', draft: 'draft_new' };
		w.getComponent(ComposerStub).vm.$emit('draft-id', 'draft_new');
		expect(routerReplace).toHaveBeenCalledTimes(1);
	});

	it('shows the subject, the sender and who the reply goes out as', async () => {
		const w = await mountAt({});
		expect(w.get('[data-testid="answer-subject"]').text()).toBe('September invoice');
		expect(w.text()).toContain('Jonas Berg');
		expect(w.get('[data-testid="answer-identity"]').text()).toContain('Answering as Ada');
	});

	it('leaves on Esc, and an untouched reply leaves no draft offer behind', async () => {
		await mountAt({});
		press({ key: 'Escape' });
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox', { replace: true });
		expect(composerFlush).not.toHaveBeenCalled();
		expect(useAnswerLeftDraft().left.value).toBeNull();
	});

	it('saves a written reply on the way out and offers it back on the list', async () => {
		await mountAt({});
		composerSnapshot.value = {
			draftId: null,
			toAddresses: ['Jonas Berg <jonas@example.com>'],
			hasContent: true,
		};
		press({ key: 'Escape' });
		await flushPromises();
		expect(composerFlush).toHaveBeenCalledTimes(1);
		expect(useAnswerLeftDraft().left.value).toEqual({
			draftId: 'draft_saved',
			messageId: 'msg_1',
			mailboxId: 'mbx_1',
			kind: 'reply',
			recipient: 'Jonas Berg',
		});
	});

	it('lets the first Esc go of the editor instead of leaving', async () => {
		await mountAt({});
		const input = document.createElement('textarea');
		document.body.appendChild(input);
		input.focus();
		input.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
		);
		expect(document.activeElement).not.toBe(input);
		expect(navigateTo).not.toHaveBeenCalled();
		input.remove();
	});

	it('goes back after a send, and forgets any offered draft', async () => {
		const w = await mountAt({ draft: 'draft_1' });
		useAnswerLeftDraft().set({
			draftId: 'draft_1' as never,
			messageId: 'msg_1',
			mailboxId: 'mbx_1',
			kind: null,
			recipient: 'Jonas',
		});
		w.getComponent(ComposerStub).vm.$emit('sent', { scheduled: false });
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox', { replace: true });
		expect(useAnswerLeftDraft().left.value).toBeNull();
	});

	it('toggles Summary / Full conversation with t', async () => {
		const w = await mountAt({});
		expect(w.get('[data-testid="conversation"]').attributes('data-view')).toBe('summary');
		press({ key: 't' });
		await flushPromises();
		expect(w.get('[data-testid="conversation"]').attributes('data-view')).toBe('full');
	});

	it('gives Cmd/Ctrl+J to "Draft with AI" and keeps it from the shell', async () => {
		await mountAt({});
		const focusAi = vi.fn();
		const unregister = useAnswerAiFocus().register(focusAi);
		const shell = vi.fn();
		document.addEventListener('keydown', shell);
		press({ key: 'j', metaKey: true });
		expect(focusAi).toHaveBeenCalledTimes(1);
		expect(shell).not.toHaveBeenCalled();
		document.removeEventListener('keydown', shell);
		unregister();
	});
});
