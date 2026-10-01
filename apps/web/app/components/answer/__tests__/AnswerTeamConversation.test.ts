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
import { defineComponent, h } from 'vue';
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

function mountColumn(messages: unknown[], view: 'summary' | 'full' = 'full') {
	return mount(AnswerTeamConversation, {
		props: {
			messages: messages as never,
			followUps: [],
			contact: null,
			answeringId: null,
			memberName: () => 'Ada',
			view,
		},
		global: {
			plugins: [createTestI18n()],
			components: {
				PostboxMessageBody: probe('PostboxMessageBody'),
				InboxMessageBody: probe('InboxMessageBody'),
				InboxMessageAttachments: inert('InboxMessageAttachments'),
				InboxThreadOutbound: inert('InboxThreadOutbound'),
				UiAvatar: inert('UiAvatar'),
			},
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
