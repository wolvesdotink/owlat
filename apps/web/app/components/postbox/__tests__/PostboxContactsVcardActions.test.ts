/**
 * The address book's vCard buttons: a picked file goes to the import and its
 * outcome comes back as one toast (written, skipped, cut off, or refused), and
 * export downloads the whole book, saying so when it could not.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import PostboxContactsVcardActions from '../PostboxContactsVcardActions.vue';

const importFile = vi.fn();
const exportBook = vi.fn();
const showToast = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useNativeFilePicker', () => ({
		isDesktop: ref(false),
		pickNativeFiles: vi.fn(async () => []),
	}));
	vi.stubGlobal('usePostboxVcardTransfer', () => ({
		isImporting: ref(false),
		isExporting: ref(false),
		importFile,
		exportBook,
	}));
});

const passthrough = defineComponent({
	setup:
		(_p, { slots }) =>
		() =>
			h('div', slots.default?.()),
});

const contacts = [{ email: 'ada@example.com', displayName: 'Ada Lovelace' }];

function mountActions(rows = contacts) {
	return mount(PostboxContactsVcardActions, {
		props: { mailboxId: 'mailbox-1' as never, contacts: rows },
		global: {
			plugins: [createTestI18n()],
			components: { UiButton, UiTooltip: passthrough, Icon: passthrough },
		},
	});
}

async function pick(wrapper: ReturnType<typeof mountActions>) {
	const input = wrapper.get('input[type="file"]');
	const file = new File(['BEGIN:VCARD'], 'contacts.vcf', { type: 'text/vcard' });
	Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
	await input.trigger('change');
	await vi.waitFor(() => expect(showToast).toHaveBeenCalled());
	return file;
}

describe('PostboxContactsVcardActions', () => {
	it('imports the picked file and reports what was written, skipped and cut off', async () => {
		importFile.mockResolvedValue({
			kind: 'done',
			created: 3,
			merged: 2,
			skippedWithoutEmail: 4,
			isTruncated: true,
		});
		const file = await pick(mountActions());
		expect(importFile).toHaveBeenCalledWith(file);
		expect(showToast).toHaveBeenCalledWith(
			'Imported: 3 new, 2 merged with existing contacts. Skipped 4 cards without an email address. Only the first 2000 contacts in the file were read.',
			'success'
		);
	});

	it('says how far an import that stopped got', async () => {
		importFile.mockResolvedValue({
			kind: 'stopped',
			created: 100,
			merged: 0,
			skippedWithoutEmail: 0,
			isTruncated: false,
		});
		await pick(mountActions());
		expect(showToast).toHaveBeenCalledWith(
			'The import stopped after 100 contacts. Those are saved.',
			'warning'
		);

		showToast.mockClear();
		importFile.mockResolvedValue({
			kind: 'stopped',
			created: 0,
			merged: 0,
			skippedWithoutEmail: 1,
			isTruncated: false,
		});
		await pick(mountActions());
		expect(showToast).toHaveBeenCalledWith(
			'The import stopped. No contacts were saved. Skipped one card without an email address.',
			'warning'
		);
	});

	it('names why a file was refused', async () => {
		importFile.mockResolvedValue({ kind: 'rejected', reason: 'too_large' });
		await pick(mountActions());
		expect(showToast).toHaveBeenCalledWith('That file is over 10 MB.', 'error');
	});

	it('exports the book, says when it could not, and offers no export for an empty book', async () => {
		const wrapper = mountActions();
		const exportButton = () =>
			wrapper.findAll('button').find((b) => b.text().includes('Export .vcf'))!;
		exportBook.mockResolvedValue(true);
		await exportButton().trigger('click');
		expect(exportBook).toHaveBeenCalledTimes(1);
		expect(showToast).not.toHaveBeenCalled();

		exportBook.mockResolvedValue(false);
		await exportButton().trigger('click');
		await vi.waitFor(() =>
			expect(showToast).toHaveBeenCalledWith(
				'The address book could not be exported. Try again.',
				'error'
			)
		);

		const empty = mountActions([]);
		const disabled = empty.findAll('button').find((b) => b.text().includes('Export .vcf'))!;
		expect(disabled.attributes('disabled')).toBeDefined();
	});
});
