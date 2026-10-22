/**
 * The Postbox attachment rows say what the assistant did with the files when
 * the delivery recorded it (`mailMessages.attachmentIndexing`), with the Team
 * inbox's sentence for the same marker: spam and automated mail under the
 * attachment gates (L6), and every other skip. An indexed message, and synced
 * mail with no marker, show no line.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import PostboxMessageAttachments from '../PostboxMessageAttachments.vue';
import MailMessageAttachmentList from '~/components/mail/MessageAttachmentList.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import type { AttachmentIndexing } from '~/utils/attachmentIndexing';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

function mountRows(indexing?: AttachmentIndexing) {
	return mount(PostboxMessageAttachments, {
		props: {
			attachments: [
				{ filename: 'invoice.pdf', contentType: 'application/pdf', size: 4096, partIndex: '2' },
			],
			messageId: 'mm_1',
			...(indexing ? { indexing } : {}),
		},
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true },
			components: { MailMessageAttachmentList },
		},
	});
}

const NOTICE = '[data-testid="postbox-attachments-not-indexed"]';

describe('PostboxMessageAttachments', () => {
	it('says the files of spam and automated mail were not read', () => {
		expect(mountRows('skipped_spam').get(NOTICE).text()).toBe(
			'The assistant has not read these files — this message was marked as spam.'
		);
		const automated = mountRows('skipped_automated');
		expect(automated.get(NOTICE).text()).toBe(
			'The assistant has not read these files — this message is a newsletter or automated mail.'
		);
		expectFullyLocalized(automated);
	});

	it('says the same for every other skip the delivery recorded', () => {
		expect(mountRows('skipped_budget').get(NOTICE).text()).toContain('processing limit');
		expect(mountRows('indexed_placeholder').get(NOTICE).text()).toContain('names of some');
	});

	it('shows no line for indexed files or an unmarked message', () => {
		expect(mountRows('indexed').find(NOTICE).exists()).toBe(false);
		expect(mountRows().find(NOTICE).exists()).toBe(false);
		expect(mountRows().text()).toContain('invoice.pdf');
	});
});
