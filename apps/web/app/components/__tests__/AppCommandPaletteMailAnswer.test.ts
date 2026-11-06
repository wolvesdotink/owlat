import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AppCommandPaletteResults from '../AppCommandPaletteResults.vue';
import type { Id } from '@owlat/api/dataModel';
import type { MailAskAnswer, MailAskCitation } from '~/composables/useCommandPaletteMailAsk';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

/**
 * Ask your mailbox in the palette: the answer, the note that only headers and
 * snippets were read, and sources that open the message they cite.
 */
beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const citation: MailAskCitation = {
	index: 1,
	messageId: 'message-1' as Id<'mailMessages'>,
	mailboxId: 'mailbox-1' as Id<'mailboxes'>,
	folderId: 'folder-1' as Id<'mailFolders'>,
	threadId: 'thread-1' as Id<'mailThreads'>,
	subject: 'Lisbon flight',
	from: 'Airline',
	date: Date.parse('2026-10-02T09:00:00Z'),
};

function mountAnswer(answer: MailAskAnswer | null) {
	return mount(AppCommandPaletteResults, {
		props: {
			groups: [],
			activeIndex: 0,
			indexById: new Map(),
			matchTerm: 'when does my flight leave',
			prompt: 'mailAsk',
			isSearching: false,
			hasRows: false,
			askAnswer: null,
			askLoading: false,
			askAvailable: true,
			mailAskAvailable: true,
			mailAskAnswer: answer,
			mailAskLoading: false,
		},
		global: { plugins: [createTestI18n()], stubs: { QueryResult: true } },
	});
}

describe('the mail answer', () => {
	it('invites a question before one is asked', () => {
		expect(mountAnswer(null).text()).toContain('Ask a question about your mail');
	});

	it('shows the answer and opens a cited message from its source', async () => {
		const wrapper = mountAnswer({
			answer: 'It leaves at 7:40 [1].',
			citations: [citation],
			bodySearchUsed: true,
			isTruncated: false,
		});
		expect(wrapper.text()).toContain('It leaves at 7:40 [1].');
		expect(wrapper.find('[data-testid="mail-ask-headers-only"]').exists()).toBe(false);
		const source = wrapper.get('button[aria-label="Open message 1: Lisbon flight"]');
		expect(source.text()).toContain('Airline');
		await source.trigger('click');
		expect(wrapper.emitted('openCitation')).toEqual([[citation]]);
	});

	it('says when it read only headers and snippets', () => {
		const wrapper = mountAnswer({
			answer: 'It leaves at 7:40 [1].',
			citations: [citation],
			bodySearchUsed: false,
			isTruncated: false,
		});
		expect(wrapper.get('[data-testid="mail-ask-headers-only"]').text()).toContain(
			'headers and snippets only'
		);
	});

	it('says so when no message matched', () => {
		const wrapper = mountAnswer({
			answer: '',
			citations: [],
			bodySearchUsed: true,
			isTruncated: false,
		});
		expect(wrapper.text()).toContain('No message in your mail matches this question.');
	});
});
