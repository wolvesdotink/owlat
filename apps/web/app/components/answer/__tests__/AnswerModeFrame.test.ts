// @vitest-environment happy-dom
/**
 * Answer mode's frame: the top bar, the two columns, and the phone tabs.
 *
 * The layout itself is CSS (two columns from 1100px, a bottom sheet from 768,
 * tabs below), which happy-dom cannot lay out; what is pinned here is the
 * structure every width relies on: both columns always mounted (a tab switch
 * must not throw away a draft being typed), the tab only deciding which one
 * the phone layout hides, and the top bar's content.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { useId } from 'vue';

import AnswerModeFrame from '../AnswerModeFrame.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n, useId });
});

function mountFrame(props: Record<string, unknown> = {}) {
	return mount(AnswerModeFrame, {
		props: {
			backLabel: 'Inbox',
			subject: 'September invoice, PO BP-2231',
			messageCount: 5,
			counterpart: 'Brightpath Finance',
			...props,
		},
		slots: {
			identity: '<span data-testid="identity">Answering as Ada</span>',
			queue: '<span data-testid="queue">1 of 3</span>',
			menu: '<button data-testid="menu">More</button>',
			conversation: '<p data-testid="thread">the thread</p>',
			composer: '<textarea data-testid="editor" />',
		},
		global: { plugins: [createTestI18n()] },
	});
}

describe('AnswerModeFrame', () => {
	it('shows the subject, the message count and the correspondent in the top bar', () => {
		const w = mountFrame();
		expect(w.get('[data-testid="answer-subject"]').text()).toBe('September invoice, PO BP-2231');
		expect(w.text()).toContain('5 messages · Brightpath Finance');
		expect(w.find('[data-testid="identity"]').exists()).toBe(true);
		expect(w.find('[data-testid="queue"]').exists()).toBe(true);
		expect(w.find('[data-testid="menu"]').exists()).toBe(true);
	});

	it('names the way back and emits it', async () => {
		const w = mountFrame();
		const back = w.get('[data-testid="answer-back"]');
		expect(back.attributes('aria-label')).toBe('Back to Inbox');
		expect(back.text()).toContain('Esc');
		await back.trigger('click');
		expect(w.emitted('back')).toHaveLength(1);
	});

	it('keeps both columns mounted and lets the tab choose what a phone hides', async () => {
		const w = mountFrame();
		const conversation = w.get('[data-testid="answer-conversation-column"]');
		const composer = w.get('[data-testid="answer-composer-column"]');
		expect(conversation.find('[data-testid="thread"]').exists()).toBe(true);
		expect(composer.find('[data-testid="editor"]').exists()).toBe(true);
		// Conversation first on a phone; the reply column hides there.
		expect(composer.classes()).toContain('max-md:hidden');
		expect(conversation.classes()).not.toContain('max-md:hidden');

		await w.get('[data-testid="answer-tab-reply"]').trigger('click');
		expect(w.emitted('update:tab')?.[0]).toEqual(['reply']);
		await w.setProps({ tab: 'reply' });
		expect(conversation.classes()).toContain('max-md:hidden');
		expect(composer.classes()).not.toContain('max-md:hidden');
		expect(composer.find('[data-testid="editor"]').exists()).toBe(true);
		expect(w.get('[data-testid="answer-tab-reply"]').attributes('aria-selected')).toBe('true');
	});

	it('says "1 message" for a single email and nothing while the count loads', () => {
		expect(mountFrame({ messageCount: 1, counterpart: '' }).text()).toContain('1 message');
		const loading = mountFrame({ messageCount: undefined, counterpart: '' });
		expect(loading.text()).not.toContain('message');
	});
});
