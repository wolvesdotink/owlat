// @vitest-environment happy-dom
/**
 * /dashboard/answer/t/<threadId>: Answer mode for a Team inbox thread (plan §07).
 *
 *   - the agent's draft opens in the editor; Send approves it unchanged;
 *   - "Answering as Team inbox" and who else is here sit in the top bar, and
 *     while a teammate is replying Send is held and says who;
 *   - the agent's questions are the ask card above the editor ("Answer and
 *     draft"), answered through the team clarification mutation;
 *   - the files: the reply's attachments and the agent's matched file under the
 *     editor; a copy still running holds Send;
 *   - `?message=` answers an older message that also waits;
 *   - a send leaves (or, in the Answer queue, moves on).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, reactive, ref, useId } from 'vue';

import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import AnswerModeFrame from '~/components/answer/AnswerModeFrame.vue';
import AnswerTeamAttachments from '~/components/answer/AnswerTeamAttachments.vue';
import AnswerTeamPresence from '~/components/answer/AnswerTeamPresence.vue';
import AttachSuggestion from '~/components/inbox/AttachSuggestion.vue';
import ThreadComposer from '~/components/inbox/ThreadComposer.vue';
import TeamPage from '../t/[threadId].vue';
import { useReviewApproveUndo } from '~/composables/useReviewApproveUndo';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});
let activeQueueSession: { handleSent: ReturnType<typeof vi.fn> } | null = null;
vi.mock('~/composables/useAnswerQueueSession', () => ({
	useAnswerQueueSession: () => activeQueueSession,
}));
// Catch-up and Draft with AI have their own suites; here they are a seam the
// test switches on and off.
const draftWithAi = ref(false);
vi.mock('~/composables/useAnswerTeamAssist', () => ({
	useAnswerTeamAssist: () => ({
		aiEnabled: draftWithAi,
		draftWithAi,
		statusNote: ref('1 of 2 asks covered'),
		catchUp: { catchUp: ref(null), loading: ref(false), covered: ref([]) },
		ask: {
			phase: ref('idle'),
			session: ref(null),
			busy: ref(false),
			injectionFlagged: ref(false),
			start: vi.fn(),
			answer: vi.fn(),
		},
	}),
}));
vi.mock('~/composables/useOrganization', () => ({
	useOrganization: () => ({
		members: ref([{ userId: 'u_priya', user: { name: 'Priya', email: 'priya@example.com' } }]),
		fetchMembers: async () => {},
	}),
}));

const route = reactive({
	path: '/dashboard/answer/t/ct_1',
	fullPath: '/dashboard/answer/t/ct_1',
	params: { threadId: 'ct_1' } as Record<string, string>,
	query: {} as Record<string, string>,
});
const navigateTo = vi.fn();
let state: Map<string, ReturnType<typeof ref>>;

function inbound(id: string, over: Record<string, unknown> = {}) {
	return {
		_id: id,
		_creationTime: 1,
		from: 'ana@example.org',
		subject: 'Invoice',
		textBody: 'Could you send the September invoice?',
		processingStatus: 'draft_ready',
		draftResponse: 'Hi Ana, here it is.',
		receivedAt: 1,
		...over,
	};
}
const messages = ref<ReturnType<typeof inbound>[]>([]);
const presence = ref<Array<{ userId: string; mode: 'viewing' | 'replying' }>>([]);
const attachmentList = ref<unknown[]>([]);
const suggestion = ref<unknown>(null);
const handleApprove = vi.fn(async () => ({ ok: true, result: {} }));
const runs = new Map<string, ReturnType<typeof vi.fn>>();

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useId,
		useHead: () => {},
		definePageMeta: () => {},
		useRoute: () => route,
		useRouter: () => ({ back: vi.fn(), currentRoute: computed(() => route) }),
		navigateTo,
		useState: (key: string, init: () => unknown) => {
			if (!state.has(key)) state.set(key, ref(init()));
			return state.get(key);
		},
		useRouteId: () => computed(() => route.params['threadId']),
		useThreadDetail: () => ({
			thread: ref({ _id: 'ct_1', subject: 'Invoice' }),
			messages,
			contact: ref({ _id: 'c_1', firstName: 'Ana', lastName: 'Ruiz', email: 'ana@example.org' }),
			followUps: ref([]),
			takeOver: ref({ messages: [], receivedWaitMs: 0 }),
			threadLoading: ref(false),
			handleApprove,
			handleReject: vi.fn(async () => ({ ok: true })),
			saveEditedDraft: vi.fn(async () => ({ ok: true, result: {} })),
			saveDraftOnly: vi.fn(async () => ({ ok: true })),
			sendFollowUp: vi.fn(async () => ({ ok: true, result: {} })),
			cancelFollowUp: vi.fn(),
		}),
		usePermissions: () => ({ isAdmin: ref(true), canManageOrganization: ref(true) }),
		useDesktopContext: () => ({ platform: ref('linux') }),
		useFeatureFlag: () => ({ isEnabled: () => true }),
		useAuth: () => ({ user: ref({ id: 'u_me' }) }),
		useToast: () => ({ showToast: vi.fn() }),
		useThreadPresence: () => ({ others: presence }),
		useConvexQuery: (query: unknown, args: () => unknown) => {
			void query;
			const a = args();
			// replyAttachments.list / suggestions and listByContact share the stub.
			if (a && typeof a === 'object' && 'threadId' in a) {
				const isList = queryCount++ % 2 === 0;
				return { data: isList ? attachmentList : suggestion, isLoading: ref(false) };
			}
			return { data: ref([]), isLoading: ref(false) };
		},
		useBackendOperation: (_fn: unknown, opts: { label: () => string }) => {
			const label = opts.label();
			const run = runs.get(label) ?? vi.fn(async () => ({ ok: true, result: [] }));
			runs.set(label, run);
			return { run, isLoading: ref(false) };
		},
	});
});
let queryCount = 0;

enableAutoUnmount(afterEach);
beforeEach(() => {
	state = new Map();
	queryCount = 0;
	activeQueueSession = null;
	route.query = {};
	messages.value = [inbound('in_1')];
	presence.value = [];
	attachmentList.value = [];
	suggestion.value = null;
	navigateTo.mockClear();
	handleApprove.mockClear();
	runs.clear();
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

async function mountPage() {
	const wrapper = mount(TeamPage, {
		attachTo: document.body,
		global: {
			plugins: [createTestI18n()],
			components: {
				AnswerModeFrame,
				AnswerTeamPresence,
				AnswerTeamAttachments,
				InboxAttachSuggestion: AttachSuggestion,
				InboxThreadComposer: ThreadComposer,
				AnswerTeamConversation: inert('AnswerTeamConversation'),
				AnswerTeamReusedAnswers: inert('AnswerTeamReusedAnswers'),
				AnswerQueueBar: inert('AnswerQueueBar'),
				PostboxOverflowMenu: passThrough('PostboxOverflowMenu'),
				PostboxComposerPreflightChip: inert('PostboxComposerPreflightChip'),
				UiAvatar: inert('UiAvatar'),
				UiSkeleton: inert('UiSkeleton'),
				UiModal: passThrough('UiModal'),
			},
			stubs: { Icon: true },
		},
	});
	await flushPromises();
	return wrapper;
}

describe('Answer mode for a Team inbox thread', () => {
	it('is Answer mode for the team inbox, answering as the team inbox', async () => {
		const wrapper = await mountPage();
		expect(wrapper.get('[data-testid="answer-subject"]').text()).toBe('Invoice');
		expect(wrapper.get('[data-testid="answer-identity"]').text()).toContain(
			'Answering as Team inbox'
		);
	});

	it('opens the agent draft in the editor, and Send approves it unchanged', async () => {
		const wrapper = await mountPage();
		const body = wrapper.get<HTMLTextAreaElement>('[data-testid="thread-composer-body"]');
		expect(body.element.value).toBe('Hi Ana, here it is.');
		await wrapper.get('[data-testid="thread-composer-send"]').trigger('click');
		await flushPromises();
		expect(handleApprove).toHaveBeenCalledWith('in_1');
		// Not in a queue: a send goes back where the reply started; opened with
		// no page to return to, that is the Team inbox.
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/inbox', { replace: true });
	});

	it("links the correspondent's name to their contact profile", async () => {
		const wrapper = await mountPage();
		const link = wrapper.get('[data-testid="answer-counterpart"]');
		expect(link.text()).toBe('Ana Ruiz');
		expect(link.attributes('href')).toBe('/dashboard/audience/contacts/c_1');
	});

	it('names the Team inbox as the way back when opened by deep link or reload', async () => {
		const wrapper = await mountPage();
		expect(wrapper.get('[data-testid="answer-back"]').attributes('aria-label')).toBe(
			'Back to Team inbox'
		);
	});

	it('arms the Approved · Undo countdown for a held approve, and its Undo cancels the send', async () => {
		handleApprove.mockResolvedValueOnce({ ok: true, result: { undo: { sendAt: 5_000 } } });
		const wrapper = await mountPage();
		await wrapper.get('[data-testid="thread-composer-send"]').trigger('click');
		await flushPromises();
		const armed = state.get('review:approve-undo')?.value as {
			visible: boolean;
			sendAt: number;
			inboundMessageId: string;
		};
		expect(armed).toMatchObject({ visible: true, sendAt: 5_000, inboundMessageId: 'in_1' });

		const undoRun = findRun('Undo approval');
		undoRun.mockResolvedValueOnce({ ok: true, result: { cancelled: true } });
		await useReviewApproveUndo().runUndo();
		expect(undoRun).toHaveBeenCalledWith({ inboundMessageId: 'in_1' });
	});

	it('in the Answer queue, a send finishes the item and moves on', async () => {
		const handleSent = vi.fn(() => true);
		activeQueueSession = { handleSent };
		const wrapper = await mountPage();
		await wrapper.get('[data-testid="thread-composer-send"]').trigger('click');
		await flushPromises();
		expect(handleSent).toHaveBeenCalledWith('sent');
		expect(navigateTo).not.toHaveBeenCalled();
	});

	it('shows who else is here, and holds Send while a teammate is replying', async () => {
		presence.value = [{ userId: 'u_priya', mode: 'replying' }];
		const wrapper = await mountPage();
		expect(wrapper.get('[data-testid="answer-team-presence"]').text()).toBe('Priya is replying');
		const send = wrapper.get('[data-testid="thread-composer-send"]');
		expect(send.text()).toBe('Priya is replying');
		expect(send.attributes('disabled')).toBeDefined();
	});

	it('says who is viewing without holding anything', async () => {
		presence.value = [{ userId: 'u_priya', mode: 'viewing' }];
		const wrapper = await mountPage();
		expect(wrapper.get('[data-testid="answer-team-presence"]').text()).toBe('Priya is viewing');
		expect(
			wrapper.get('[data-testid="thread-composer-send"]').attributes('disabled')
		).toBeUndefined();
	});

	it('offers Draft with AI above the editor when it is on, with the asks covered beside Send', async () => {
		draftWithAi.value = true;
		const wrapper = await mountPage();
		expect(wrapper.find('[data-testid="answer-ai-bar"]').exists()).toBe(true);
		expect(wrapper.get('[data-testid="thread-composer-status"]').text()).toBe(
			'1 of 2 asks covered'
		);
		draftWithAi.value = false;
	});

	it('puts the agent questions above the editor as the ask card, "Answer and draft"', async () => {
		messages.value = [
			inbound('in_1', {
				processingStatus: 'awaiting_clarification',
				draftResponse: undefined,
				pendingClarification: {
					questions: [{ id: 'q1', text: 'Is the PO on the invoice?', options: ['Yes', 'No'] }],
				},
			}),
		];
		const wrapper = await mountPage();
		const ask = wrapper.get('[data-testid="answer-team-clarification"]');
		expect(ask.text()).toContain('Is the PO on the invoice?');
		expect(wrapper.get('[data-testid="ask-submit"]').text()).toContain('Answer and draft');
		const html = wrapper.html();
		expect(html.indexOf('answer-team-clarification')).toBeLessThan(
			html.indexOf('thread-composer-body')
		);
		// Every question needs an answer before the agent drafts.
		expect(wrapper.get('[data-testid="ask-submit"]').attributes('disabled')).toBeDefined();

		await wrapper.findAll('[data-testid="ask-chip"]')[0]!.trigger('click');
		await wrapper.get('[data-testid="ask-submit"]').trigger('click');
		await flushPromises();
		const answer = findRun('Answer clarification');
		expect(answer).toHaveBeenCalledWith({
			inboundMessageId: 'in_1',
			answers: [{ questionId: 'q1', value: 'Yes', source: 'user' }],
		});
	});

	it('leaves a file answer to the server, which attaches it with the answer', async () => {
		messages.value = [
			inbound('in_1', {
				processingStatus: 'awaiting_clarification',
				draftResponse: undefined,
				pendingClarification: {
					questions: [{ id: 'q1', text: 'Which invoice?', options: ['September'] }],
				},
			}),
		];
		const wrapper = await mountPage();
		const answers = [
			{
				questionId: 'q1',
				file: { source: 'upload', id: 'st_1', filename: 'inv.pdf' },
				keepCopy: false,
			},
		];
		wrapper.getComponent({ name: 'AskCard' }).vm.$emit('answer', answers);
		await flushPromises();
		expect(findRun('Answer clarification')).toHaveBeenCalledTimes(1);
		// No second attach from the client: the upload is already bound to the reply,
		// and attaching it again would fail.
		const attachCalls = [...runs]
			.filter(([label]) => label === 'Attach file')
			.flatMap(([, run]) => run.mock.calls);
		expect(attachCalls).toEqual([]);
	});

	it('shows the reply’s files and the agent’s matched file; a running copy holds Send', async () => {
		attachmentList.value = [
			{
				index: 0,
				id: 'a1',
				filename: 'po.pdf',
				contentType: 'application/pdf',
				size: 10,
				origin: 'semanticFile',
				status: 'copying',
				url: null,
				addedBy: 'u_me',
				addedAt: 1,
			},
		];
		suggestion.value = {
			inboundMessageId: 'in_1',
			query: 'invoice',
			ambiguous: false,
			candidates: [
				{
					fileId: 'sf_9',
					storageId: 'st_9',
					filename: 'invoice-2026-09.pdf',
					mimeType: 'application/pdf',
					fileSize: 10,
					score: 0.9,
				},
			],
		};
		const wrapper = await mountPage();
		expect(wrapper.get('[data-testid="answer-team-attachment"]').text()).toContain('po.pdf');
		expect(wrapper.find('[data-testid="attach-suggestion"]').exists()).toBe(true);
		expect(
			wrapper.get('[data-testid="thread-composer-send"]').attributes('disabled')
		).toBeDefined();
		expect(wrapper.get('[data-testid="thread-composer-send-hold"]').text()).toBe(
			'Send waits until the file is copied.'
		);

		await wrapper.get('[data-testid="attach-suggestion"]').trigger('click');
		await flushPromises();
		expect(findRun('Attach file')).toHaveBeenCalledWith({
			threadId: 'ct_1',
			source: 'semanticFile',
			id: 'sf_9',
		});
	});

	it('puts the caret in the reply inside the phone row tap', async () => {
		const wrapper = await mountPage();
		const body = wrapper.get<HTMLTextAreaElement>('[data-testid="thread-composer-body"]');
		body.element.blur();
		wrapper.getComponent(AnswerModeFrame).vm.$emit('start-reply');
		// No render in between: iOS raises the keyboard only for a focus in the tap.
		expect(document.activeElement).toBe(body.element);
	});

	it('opens on the questions of the message ?message= names, not a newer draft', async () => {
		route.query = { message: 'in_old' };
		messages.value = [
			inbound('in_old', {
				_creationTime: 1,
				processingStatus: 'awaiting_clarification',
				draftResponse: undefined,
				pendingClarification: {
					questions: [{ id: 'q1', question: 'Which invoice?', options: [] }],
				},
			}),
			inbound('in_new', { _creationTime: 2, draftResponse: 'New draft' }),
		];
		const wrapper = await mountPage();
		expect(wrapper.find('[data-testid="answer-team-clarification"]').exists()).toBe(true);
		expect(
			wrapper.get<HTMLTextAreaElement>('[data-testid="thread-composer-body"]').element.value
		).not.toBe('New draft');
	});

	it('falls back to the thread pick when ?message= names a message already answered', async () => {
		route.query = { message: 'in_old' };
		messages.value = [
			inbound('in_old', { _creationTime: 1, processingStatus: 'sent', draftResponse: 'Sent' }),
			inbound('in_new', { _creationTime: 2, draftResponse: 'New draft' }),
		];
		const wrapper = await mountPage();
		expect(
			wrapper.get<HTMLTextAreaElement>('[data-testid="thread-composer-body"]').element.value
		).toBe('New draft');
	});

	it('answers the message ?message= names when it still waits', async () => {
		route.query = { message: 'in_old' };
		messages.value = [
			inbound('in_old', { _creationTime: 1, draftResponse: 'Old draft' }),
			inbound('in_new', { _creationTime: 2, draftResponse: 'New draft' }),
		];
		const wrapper = await mountPage();
		expect(
			wrapper.get<HTMLTextAreaElement>('[data-testid="thread-composer-body"]').element.value
		).toBe('Old draft');
	});
});

/** The operation whose label contains `fragment`. */
function findRun(fragment: string) {
	for (const [label, run] of runs) if (label.includes(fragment)) return run;
	throw new Error(`no operation labelled like "${fragment}": ${[...runs.keys()].join(', ')}`);
}
