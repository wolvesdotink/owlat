// @vitest-environment happy-dom
/**
 * Answer mode's Team inbox conversation column, for a message whose body is
 * too large for its row (#912): the query hands back only its excerpt and the
 * storage ids, so the column must not say "no text content". It mounts the
 * thread page's body component, which shows the excerpt and fetches the rest;
 * a message with its body on the row still renders through the sandboxed HTML
 * body component. The collapsed row previews the excerpt.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';

import AnswerTeamConversation from '../AnswerTeamConversation.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const message = (id: string, creation: number, over: Record<string, unknown> = {}) => ({
	_id: id,
	_creationTime: creation,
	from: 'ana@example.org',
	subject: 'Invoice',
	processingStatus: 'draft_ready',
	...over,
});

const probe = (name: string) =>
	defineComponent({
		name,
		props: { message: { type: Object, required: true } },
		setup: (props) => () =>
			h('div', { 'data-testid': name }, String((props.message as { _id: string })._id)),
	});
const inert = (name: string) => defineComponent({ name, setup: () => () => h('div') });

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountColumn(
	messages: unknown[],
	view: 'summary' | 'full' = 'full',
	extra: Record<string, unknown> = {}
) {
	return mount(AnswerTeamConversation, {
		props: {
			messages: messages as never,
			contact: null,
			answeringId: null,
			memberName: () => 'Ada',
			view,
			...extra,
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				PostboxMessageBody: probe('PostboxMessageBody'),
				InboxMessageBody: probe('InboxMessageBody'),
				InboxMessageAttachments: inert('InboxMessageAttachments'),
				InboxAutoSendCountdown: inert('InboxAutoSendCountdown'),
				InboxNoteComposer: inert('InboxNoteComposer'),
				UiAvatar: inert('UiAvatar'),
				UiButton: defineComponent({
					emits: ['click'],
					setup:
						(_, { slots, emit, attrs }) =>
						() =>
							h('button', { ...attrs, onClick: () => emit('click') }, slots['default']?.()),
				}),
			},
			stubs: { Icon: true },
		},
	});
}

describe('AnswerTeamConversation, large bodies', () => {
	it('shows a body held in storage through the thread page body component', () => {
		const w = mountColumn([
			message('in_small', 1, { htmlBody: '<p>Hi</p>', textBody: 'Hi' }),
			message('in_large', 2, {
				htmlBodyStorageId: 'st_1',
				bodyExcerpt: 'The first part of a very long newsletter',
			}),
		]);
		expect(w.get('[data-testid="PostboxMessageBody"]').text()).toBe('in_small');
		expect(w.get('[data-testid="InboxMessageBody"]').text()).toBe('in_large');
		expect(w.text()).not.toContain('No text content');
	});

	it('previews the excerpt on a collapsed row', () => {
		const w = mountColumn(
			[
				message('in_large', 1, {
					textBodyStorageId: 'st_2',
					bodyExcerpt: 'The first part of a very long message',
				}),
				message('in_new', 2, { textBody: 'Any news?' }),
			],
			'summary'
		);
		expect(w.get('[data-testid="answer-team-message-preview"]').text()).toBe(
			'The first part of a very long message'
		);
	});
});

describe('AnswerTeamConversation, the team stream', () => {
	const at = (n: number) => ({ at: n, tie: n });
	const stream = [
		{
			kind: 'customerEmail',
			key: 'email:in_1',
			...at(1),
			source: { kind: 'inbound', id: 'in_1' },
			fromEmail: 'ana@example.org',
			preview: '',
		},
		{
			kind: 'note',
			key: 'note:n1',
			...at(2),
			noteSource: 'threadNote',
			noteId: 'n1',
			authorId: 'u',
			authorName: 'Mika',
			body: 'Courier damage',
			mentionedUserIds: [],
			isDeleted: false,
			reactions: [],
		},
		{
			kind: 'teamReply',
			key: 'reply:s1',
			...at(3),
			isAgent: true,
			status: 'queued',
			toName: 'Ana',
			preview: 'Snapshot text',
			body: 'Snapshot text',
		},
		{
			kind: 'teamReply',
			key: 'reply:s2',
			...at(4),
			isAgent: false,
			status: 'failed',
			toName: 'Ana',
			preview: 'Second',
			body: 'Second',
			errorMessage: 'Mailbox full',
		},
	];

	it('shows the replies as they went out, with their status, in stream order', () => {
		const w = mountColumn(
			[message('in_1', 1, { textBody: 'Hi', draftResponse: 'Approved draft text' })],
			'full',
			{
				stream,
			}
		);
		const replies = w.findAll('[data-testid="team-stream-reply"]');
		expect(replies.map((r) => r.attributes('data-status'))).toEqual(['queued', 'failed']);
		expect(w.text()).toContain('Snapshot text');
		expect(w.text()).not.toContain('Approved draft text');
		expect(w.text()).toContain('Mailbox full');
		const order = w.findAll(
			'[data-testid="answer-team-message"], [data-testid="team-stream-note"], [data-testid="team-stream-reply"]'
		);
		expect(order.map((e) => e.attributes('data-testid'))).toEqual([
			'answer-team-message',
			'team-stream-note',
			'team-stream-reply',
			'team-stream-reply',
		]);
	});

	it('offers older entries and asks for them', async () => {
		const w = mountColumn([message('in_1', 1, { textBody: 'Hi' })], 'full', {
			stream,
			hasEarlier: true,
		});
		await w.get('[data-testid="team-stream-earlier"]').trigger('click');
		expect(w.emitted('load-earlier')).toHaveLength(1);
	});

	it('shows the messages alone until the stream is there', () => {
		const w = mountColumn([message('in_1', 1, { textBody: 'Hi' })], 'full');
		expect(w.findAll('[data-testid="answer-team-message"]')).toHaveLength(1);
		expect(w.find('[data-testid="team-stream-reply"]').exists()).toBe(false);
	});
});

describe('AnswerTeamConversation, a citation', () => {
	it('opens a collapsed older message and says when the target is not loaded', async () => {
		const stream = [
			{
				kind: 'customerEmail',
				key: 'email:in_old',
				at: 1,
				tie: 1,
				source: { kind: 'inbound', id: 'in_old' },
				fromEmail: 'ana@example.org',
				preview: '',
			},
			{
				kind: 'customerEmail',
				key: 'email:in_new',
				at: 2,
				tie: 2,
				source: { kind: 'inbound', id: 'in_new' },
				fromEmail: 'ana@example.org',
				preview: '',
			},
		];
		const w = mountColumn(
			[
				message('in_old', 1, { textBody: 'Old one' }),
				message('in_new', 2, { textBody: 'New one' }),
			],
			'summary',
			{ stream }
		);
		const rows = () => w.findAll('[data-testid="answer-team-message"]');
		expect(rows()[0]!.find('[data-testid="answer-team-message-body"]').exists()).toBe(false);
		const vm = w.vm as unknown as { reveal: (id: string) => boolean };
		expect(vm.reveal('in_old')).toBe(true);
		await nextTick();
		expect(rows()[0]!.find('[data-testid="answer-team-message-body"]').exists()).toBe(true);
		expect(vm.reveal('in_unloaded')).toBe(false);
	});
});
