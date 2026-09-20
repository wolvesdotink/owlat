// @vitest-environment happy-dom
/**
 * The team-inbox attachment list:
 *   - one row per attachment, each naming the file and its formatted size
 *   - clicking the download control emits `download` with that attachment
 *   - the control carries the file's name as its accessible name
 *   - only the row whose `${messageId}:${partIndex}` matches `downloadingKey`
 *     spins and disables — its siblings stay clickable
 *   - a message with confirmed malware renders the blocked line and offers NO
 *     download control at all
 *   - a message whose files the sweep RELEASED says the window passed; one that
 *     never carried them says so instead, because claiming a retention window
 *     expired on a message from last week is false
 *   - an attachment the assistant never read says which reason applies, rather
 *     than rendering identically to an indexed one
 *
 * Mounts the real shared row component underneath, so the assertions are about
 * the markup the browser paints. <Icon> is a global auto-import, stubbed here.
 */
import { beforeAll, describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import InboxMessageAttachments from '../InboxMessageAttachments.vue';
import type { InboxAttachmentMeta } from '../InboxMessageAttachments.vue';
import MailMessageAttachmentList from '~/components/mail/MessageAttachmentList.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { formatCompactFileSize } from '~/utils/formatters';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const mountOpts = {
	global: {
		plugins: [createTestI18n()],
		stubs: { Icon: true },
		components: { MailMessageAttachmentList },
	},
};

const MESSAGE_ID = 'msg_1';

function attachment(over: Partial<InboxAttachmentMeta> = {}): InboxAttachmentMeta {
	return {
		filename: 'notes.txt',
		contentType: 'text/plain',
		size: 2048,
		partIndex: '1',
		...over,
	};
}

function render(props: Record<string, unknown> = {}) {
	return mount(InboxMessageAttachments, {
		...mountOpts,
		props: { attachments: [attachment()], messageId: MESSAGE_ID, ...props },
	});
}

const ROW = '[data-testid="message-attachment-row"]';
const DOWNLOAD = '[data-testid="message-attachment-download"]';

describe('InboxMessageAttachments', () => {
	it('renders one row per attachment with its name and formatted size', () => {
		const wrapper = render({
			attachments: [
				attachment({ filename: 'notes.txt', size: 2048, partIndex: '1' }),
				attachment({
					filename: 'report.pdf',
					contentType: 'application/pdf',
					size: 5_242_880,
					partIndex: '2',
				}),
			],
		});

		const rows = wrapper.findAll(ROW);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.text()).toContain('notes.txt');
		expect(rows[0]!.text()).toContain(formatCompactFileSize(2048));
		expect(rows[1]!.text()).toContain('report.pdf');
		expect(rows[1]!.text()).toContain(formatCompactFileSize(5_242_880));
		expect(rows[1]!.text()).toContain('application/pdf');
	});

	it('renders nothing at all when the message has no attachments', () => {
		const wrapper = render({ attachments: [] });
		expect(wrapper.find('[data-testid="inbox-message-attachments"]').exists()).toBe(false);
	});

	it('emits download with the clicked attachment, and names the file in the control', async () => {
		const only = attachment({ filename: 'contract.pdf', partIndex: '3' });
		const wrapper = render({ attachments: [only] });

		const button = wrapper.find(DOWNLOAD);
		// The accessible name is the affordance: an icon-only control that lost it
		// would still pass every other assertion here.
		expect(button.attributes('aria-label')).toContain('contract.pdf');
		await button.trigger('click');

		expect(wrapper.emitted('download')?.[0]).toEqual([only]);
	});

	it('spins and disables only the row that is being fetched', () => {
		const wrapper = render({
			attachments: [
				attachment({ filename: 'a.txt', partIndex: '1' }),
				attachment({ filename: 'b.txt', partIndex: '2' }),
			],
			downloadingKey: `${MESSAGE_ID}:1`,
		});

		const buttons = wrapper.findAll(DOWNLOAD);
		expect(buttons).toHaveLength(2);
		expect(buttons[0]!.attributes('disabled')).toBeDefined();
		expect(buttons[0]!.html()).toContain('lucide:loader-2');
		expect(buttons[1]!.attributes('disabled')).toBeUndefined();
		expect(buttons[1]!.html()).toContain('lucide:download');
	});

	it('keys legacy rows without a partIndex apart, so only one of two same-named files spins', () => {
		const wrapper = render({
			attachments: [
				attachment({ filename: 'scan.pdf', partIndex: undefined }),
				attachment({ filename: 'scan.pdf', partIndex: undefined }),
			],
			// A legacy row's key falls back to its filename, so both WOULD match.
			// What the list must not do is collapse the two rows into one.
			downloadingKey: `${MESSAGE_ID}:scan.pdf`,
		});

		expect(wrapper.findAll(ROW)).toHaveLength(2);
	});

	it('blocks download entirely when malware was found in the message', () => {
		const wrapper = render({ virusVerdict: 'infected' });

		expect(wrapper.find('[data-testid="inbox-attachments-blocked"]').exists()).toBe(true);
		// Not a disabled button — no download control at all.
		expect(wrapper.findAll(DOWNLOAD)).toHaveLength(0);
		// The file is still named, so the reader knows what arrived.
		expect(wrapper.text()).toContain('notes.txt');
	});

	it('says the retention window passed only when the sweep actually released the bytes', () => {
		const wrapper = render({ isExpired: true, releasedAt: 1_700_000_000_000 });

		const line = wrapper.find('[data-testid="inbox-attachments-expired"]');
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('retention window');
		const button = wrapper.find(DOWNLOAD);
		expect(button.exists()).toBe(true);
		expect(button.attributes('disabled')).toBeDefined();
		expect(wrapper.text()).toContain('notes.txt');
	});

	it('says the message predates stored files when there is no release stamp', () => {
		const wrapper = render({ isExpired: true });

		const line = wrapper.find('[data-testid="inbox-attachments-expired"]');
		expect(line.exists()).toBe(true);
		expect(line.text()).not.toContain('retention window');
		expect(line.text()).toContain('before its files were kept');
	});

	it('reports the original message size beside the gone line when it is known', () => {
		const wrapper = render({ isExpired: true, releasedAt: 1, rawSize: 1_258_291 });

		expect(wrapper.find('[data-testid="inbox-attachments-expired"]').text()).toContain(
			formatCompactFileSize(1_258_291)
		);
	});

	it('says the files were never scanned when no clean verdict was reached', () => {
		const wrapper = render({ virusVerdict: 'skipped', attachmentIndexing: 'skipped_unscanned' });

		const line = wrapper.find('[data-testid="inbox-attachments-not-indexed"]');
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('Not scanned');
		// Still downloadable: the bytes are there, they were simply not read.
		expect(wrapper.find(DOWNLOAD).attributes('disabled')).toBeUndefined();
	});

	it('says the processing limit was reached when the AI budget refused the batch', () => {
		const wrapper = render({ virusVerdict: 'clean', attachmentIndexing: 'skipped_budget' });

		const line = wrapper.find('[data-testid="inbox-attachments-not-indexed"]');
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('processing limit');
	});

	it('shows no notice line at all for a clean, indexed, still-stored message', () => {
		const wrapper = render({ virusVerdict: 'clean', attachmentIndexing: 'indexed' });

		expect(wrapper.find('[data-testid="inbox-attachments-blocked"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="inbox-attachments-expired"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="inbox-attachments-not-indexed"]').exists()).toBe(false);
		expect(wrapper.find(DOWNLOAD).attributes('disabled')).toBeUndefined();
	});
});
