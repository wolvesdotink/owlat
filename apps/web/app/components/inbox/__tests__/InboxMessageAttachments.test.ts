// @vitest-environment happy-dom
/**
 * The team-inbox attachment list:
 *   - one row per attachment, each naming the file and its formatted size
 *   - clicking the download control emits `download` with that attachment
 *   - only the row whose `${messageId}:${partIndex}` matches `downloadingKey`
 *     spins and disables — its siblings stay clickable
 *   - a message with confirmed malware renders the blocked line and offers NO
 *     download control at all
 *   - a message whose files were swept renders the expired line with the
 *     control present but disabled, so the reason sits beside the affordance
 *
 * <Icon> is a global auto-import, stubbed here.
 */
import { beforeAll, describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import InboxMessageAttachments from '../InboxMessageAttachments.vue';
import type { InboxAttachmentMeta } from '../InboxMessageAttachments.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { formatCompactFileSize } from '~/utils/formatters';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const mountOpts = {
	global: { plugins: [createTestI18n()], stubs: { Icon: true } },
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

describe('InboxMessageAttachments', () => {
	it('renders one row per attachment with its name and formatted size', () => {
		const wrapper = render({
			attachments: [
				attachment({ filename: 'notes.txt', size: 2048, partIndex: '1' }),
				attachment({ filename: 'report.pdf', contentType: 'application/pdf', size: 5_242_880, partIndex: '2' }),
			],
		});

		const rows = wrapper.findAll('[data-testid="inbox-attachment-row"]');
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

	it('emits download with the clicked attachment', async () => {
		const only = attachment({ filename: 'contract.pdf', partIndex: '3' });
		const wrapper = render({ attachments: [only] });

		await wrapper.find('[data-testid="inbox-attachment-download"]').trigger('click');

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

		const buttons = wrapper.findAll('[data-testid="inbox-attachment-download"]');
		expect(buttons).toHaveLength(2);
		expect(buttons[0]!.attributes('disabled')).toBeDefined();
		expect(buttons[0]!.html()).toContain('lucide:loader-2');
		expect(buttons[1]!.attributes('disabled')).toBeUndefined();
		expect(buttons[1]!.html()).toContain('lucide:download');
	});

	it('blocks download entirely when malware was found in the message', () => {
		const wrapper = render({ virusVerdict: 'infected' });

		expect(wrapper.find('[data-testid="inbox-attachments-blocked"]').exists()).toBe(true);
		// Not a disabled button — no download control at all.
		expect(wrapper.findAll('[data-testid="inbox-attachment-download"]')).toHaveLength(0);
		// The file is still named, so the reader knows what arrived.
		expect(wrapper.text()).toContain('notes.txt');
	});

	it('names the files but disables download once the retention window passed', () => {
		const wrapper = render({ isExpired: true });

		expect(wrapper.find('[data-testid="inbox-attachments-expired"]').exists()).toBe(true);
		const button = wrapper.find('[data-testid="inbox-attachment-download"]');
		expect(button.exists()).toBe(true);
		expect(button.attributes('disabled')).toBeDefined();
		expect(wrapper.text()).toContain('notes.txt');
	});

	it('shows neither the blocked nor the expired line in the normal case', () => {
		const wrapper = render({ virusVerdict: 'clean' });

		expect(wrapper.find('[data-testid="inbox-attachments-blocked"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="inbox-attachments-expired"]').exists()).toBe(false);
		expect(
			wrapper.find('[data-testid="inbox-attachment-download"]').attributes('disabled')
		).toBeUndefined();
	});
});
