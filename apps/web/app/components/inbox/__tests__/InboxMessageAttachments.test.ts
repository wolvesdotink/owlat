// @vitest-environment happy-dom
/**
 * The team-inbox attachment list:
 *   - one row per attachment parsed off the message's `attachmentMeta`, each
 *     naming the file and its formatted size
 *   - clicking the download control asks the download composable for THAT
 *     message and THAT part
 *   - the control carries the file's name as its accessible name
 *   - only the row whose `${messageId}:${partIndex}` matches the in-flight key
 *     spins and disables — its siblings stay clickable
 *   - a message with confirmed malware renders the blocked line and offers NO
 *     download control at all
 *   - a message whose files the sweep RELEASED says the window passed; one with
 *     no stamp says only that the files were not stored, because "this message
 *     predates the feature" is one of three ways to get here and the reader
 *     cannot be told the wrong one
 *   - each reason the assistant did not read a file says WHICH, rather than
 *     rendering identically to an indexed one
 *   - in the gone state the download control stays FOCUSABLE and carries
 *     `aria-describedby` to the line that says why, rather than dropping out of
 *     the tab order with the reason unattached
 *
 * The component takes the ROW, so this suite is also where the row-to-state
 * mapping is pinned: which column means gone, which means swept, which means
 * unread. It used to be spelled at the call site inside a 1000-line page, where
 * nothing checked it.
 *
 * Mounts the real shared row component underneath, so the assertions are about
 * the markup the browser paints. <Icon> is a global auto-import, stubbed here.
 */
import { beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

import type { AttachmentMeta } from '~/utils/attachmentMeta';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { formatCompactFileSize } from '~/utils/formatters';

/**
 * The download half, stubbed: fetching a raw `.eml` and extracting a MIME part
 * is `useMimePartDownload`'s own suite. What matters here is that this
 * component asks for the right message and the right part, and that the key it
 * hands back drives the spinner.
 */
const downloadingAttachment = ref<string | null>(null);
const handleAttachmentDownload = vi.fn();
vi.mock('~/composables/useMimePartDownload', () => ({
	useMimePartDownload: () => ({
		downloadingAttachment,
		extractPartBlob: vi.fn(),
		handleAttachmentDownload,
	}),
}));
vi.mock('~/composables/loadInboundRawEml', () => ({ loadInboundRawEml: vi.fn() }));

const InboxMessageAttachments = (await import('../InboxMessageAttachments.vue')).default;
const MailMessageAttachmentList = (await import('~/components/mail/MessageAttachmentList.vue'))
	.default;

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

beforeEach(() => {
	downloadingAttachment.value = null;
	handleAttachmentDownload.mockClear();
});

const mountOpts = {
	global: {
		plugins: [createTestI18n()],
		stubs: { Icon: true },
		components: { MailMessageAttachmentList },
	},
};

const MESSAGE_ID = 'msg_1';

function attachment(over: Partial<AttachmentMeta> = {}): AttachmentMeta {
	return {
		filename: 'notes.txt',
		contentType: 'text/plain',
		size: 2048,
		partIndex: '1',
		...over,
	};
}

/**
 * One `inboundMessages` row as the thread query returns it — `attachmentMeta`
 * is the JSON STRING the ingest route wrote, so the parser is exercised too.
 */
function message(over: Record<string, unknown> = {}, attachments = [attachment()]) {
	return {
		_id: MESSAGE_ID,
		attachmentMeta: JSON.stringify(attachments),
		// The shape the string is in. Version 1 is the raw-carrying route's: its
		// `partIndex` addresses a part inside the sealed `.eml`. A version-0 row
		// has no bytes at all — its own case below.
		attachmentMetaVersion: 1,
		rawStorageId: 'storage_1',
		...over,
	};
}

function render(row: Record<string, unknown> = message()) {
	return mount(InboxMessageAttachments, { ...mountOpts, props: { message: row } });
}

const ROW = '[data-testid="message-attachment-row"]';
const DOWNLOAD = '[data-testid="message-attachment-download"]';
const GONE = '[data-testid="inbox-attachments-gone"]';
const NOT_INDEXED = '[data-testid="inbox-attachments-not-indexed"]';

describe('InboxMessageAttachments', () => {
	it('renders one row per attachment with its name and formatted size', () => {
		const wrapper = render(
			message({}, [
				attachment({ filename: 'notes.txt', size: 2048, partIndex: '1' }),
				attachment({
					filename: 'report.pdf',
					contentType: 'application/pdf',
					size: 5_242_880,
					partIndex: '2',
				}),
			])
		);

		const rows = wrapper.findAll(ROW);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.text()).toContain('notes.txt');
		expect(rows[0]!.text()).toContain(formatCompactFileSize(2048));
		expect(rows[1]!.text()).toContain('report.pdf');
		expect(rows[1]!.text()).toContain(formatCompactFileSize(5_242_880));
		// A short type, not the raw MIME type; the MIME type stays in the title.
		expect(rows[1]!.text()).toContain('· PDF');
		expect(rows[1]!.text()).not.toContain('application/pdf');
		expect(rows[1]!.find('[title="application/pdf"]').exists()).toBe(true);
	});

	it('renders nothing at all when the message has no attachments', () => {
		const wrapper = render(message({ attachmentMeta: undefined }));
		expect(wrapper.find('[data-testid="inbox-message-attachments"]').exists()).toBe(false);
	});

	it('renders nothing rather than breaking when attachmentMeta is malformed', () => {
		// Sender-controlled JSON: the thread view must survive it.
		const wrapper = render(message({ attachmentMeta: '{not json' }));
		expect(wrapper.find('[data-testid="inbox-message-attachments"]').exists()).toBe(false);
	});

	it('downloads the clicked part of this message, and names the file in the control', async () => {
		const only = attachment({ filename: 'contract.pdf', partIndex: '3' });
		const wrapper = render(message({}, [only]));

		const button = wrapper.find(DOWNLOAD);
		// The accessible name is the affordance: an icon-only control that lost it
		// would still pass every other assertion here.
		expect(button.attributes('aria-label')).toContain('contract.pdf');
		await button.trigger('click');

		expect(handleAttachmentDownload).toHaveBeenCalledWith(MESSAGE_ID, only);
	});

	it('spins and disables only the row that is being fetched', () => {
		downloadingAttachment.value = `${MESSAGE_ID}:1`;
		const wrapper = render(
			message({}, [
				attachment({ filename: 'a.txt', partIndex: '1' }),
				attachment({ filename: 'b.txt', partIndex: '2' }),
			])
		);

		const buttons = wrapper.findAll(DOWNLOAD);
		expect(buttons).toHaveLength(2);
		expect(buttons[0]!.attributes('disabled')).toBeDefined();
		expect(buttons[0]!.html()).toContain('lucide:loader-2');
		expect(buttons[1]!.attributes('disabled')).toBeUndefined();
		expect(buttons[1]!.html()).toContain('lucide:download');
	});

	it('renders two legacy same-named rows as two rows, both spinning together', () => {
		// A row with no `partIndex` keys off its position AND its name, so two
		// files called `scan.pdf` are two rows rather than one. Their DOWNLOAD key
		// is the filename, which they share — so both spin while either is
		// fetched. That is the accepted limit of legacy metadata; what the list
		// must never do is collapse the rows.
		downloadingAttachment.value = `${MESSAGE_ID}:scan.pdf`;
		const wrapper = render(
			message({}, [
				attachment({ filename: 'scan.pdf', partIndex: undefined }),
				attachment({ filename: 'scan.pdf', partIndex: undefined }),
			])
		);

		expect(wrapper.findAll(ROW)).toHaveLength(2);
		const buttons = wrapper.findAll(DOWNLOAD);
		expect(buttons.map((b) => b.attributes('disabled'))).toEqual(['', '']);
	});

	it('blocks download entirely when malware was found in the message', () => {
		const wrapper = render(message({ virusVerdict: 'infected' }));

		expect(wrapper.find('[data-testid="inbox-attachments-blocked"]').exists()).toBe(true);
		// Not a disabled button — no download control at all.
		expect(wrapper.findAll(DOWNLOAD)).toHaveLength(0);
		// The file is still named, so the reader knows what arrived.
		expect(wrapper.text()).toContain('notes.txt');
	});

	it('says the retention window passed only when the sweep actually released the bytes', () => {
		const wrapper = render(message({ rawStorageId: undefined, rawReleasedAt: 1_700_000_000_000 }));

		const line = wrapper.find(GONE);
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('retention window');
		const button = wrapper.find(DOWNLOAD);
		expect(button.exists()).toBe(true);
		expect(button.attributes('aria-disabled')).toBe('true');
		expect(wrapper.text()).toContain('notes.txt');
	});

	it('says only that the files were not stored when there is no release stamp', () => {
		const wrapper = render(message({ rawStorageId: undefined }));

		// Three different paths produce a message with attachments and no
		// `rawStorageId` TODAY: a payload over the action-argument budget, a raw
		// that did not decode, and a message from before the route carried bytes.
		// Naming the third sends an admin hunting for a feature-age explanation
		// when the truth was a size ceiling.
		const line = wrapper.find(GONE);
		expect(line.exists()).toBe(true);
		expect(line.text()).not.toContain('retention window');
		expect(line.text()).not.toContain('arrived before');
		expect(line.text()).toContain('were not stored');
	});

	it('keeps the gone download reachable and points it at the reason', async () => {
		// `disabled` removes the control from the tab order, so a screen-reader
		// user moving through the message meets rows that cannot be fetched and is
		// never told why — the explanation is a paragraph they may have passed.
		const wrapper = render(message({ rawStorageId: undefined, rawReleasedAt: 1 }));

		const button = wrapper.find(DOWNLOAD);
		expect(button.attributes('disabled')).toBeUndefined();
		expect(button.attributes('aria-disabled')).toBe('true');
		const describedBy = button.attributes('aria-describedby');
		expect(describedBy).toBeTruthy();
		expect(wrapper.find(`#${describedBy}`).text()).toContain('retention window');

		// And advisory means advisory: the click is refused here, not by the
		// browser.
		await button.trigger('click');
		expect(handleAttachmentDownload).not.toHaveBeenCalled();
	});

	it('marks the row busy while its bytes are being fetched', () => {
		downloadingAttachment.value = `${MESSAGE_ID}:1`;
		const wrapper = render(message({}, [attachment({ partIndex: '1' })]));

		expect(wrapper.find(ROW).attributes('aria-busy')).toBe('true');
	});

	it('leaves a message that still holds its bytes alone', () => {
		// The other half of the mapping above: `rawStorageId` present is the ONLY
		// thing that separates a live message from a swept one, and inverting that
		// test would mark every message as gone.
		const wrapper = render(message({ rawStorageId: 'storage_9', rawReleasedAt: undefined }));

		expect(wrapper.find(GONE).exists()).toBe(false);
		expect(wrapper.find(DOWNLOAD).attributes('disabled')).toBeUndefined();
	});

	it('reports the original message size beside the gone line when it is known', () => {
		const wrapper = render(
			message({ rawStorageId: undefined, rawReleasedAt: 1, rawSize: 1_258_291 })
		);

		expect(wrapper.find(GONE).text()).toContain(formatCompactFileSize(1_258_291));
	});

	it('keeps the gone line and the size as separate sentences, not one glued string', () => {
		// Two translated sentences joined in code would bake English spacing and
		// ordering into every locale.
		const wrapper = render(
			message({ rawStorageId: undefined, rawReleasedAt: 1, rawSize: 1_258_291 })
		);

		const spans = wrapper.findAll(`${GONE} span`);
		expect(spans).toHaveLength(2);
		expect(spans[1]!.text()).toContain(formatCompactFileSize(1_258_291));
	});

	it('says the files were never scanned when no clean verdict was reached', () => {
		const wrapper = render(
			message({ virusVerdict: 'skipped', attachmentIndexing: 'skipped_unscanned' })
		);

		const line = wrapper.find(NOT_INDEXED);
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('Not scanned');
		// Still downloadable: the bytes are there, they were simply not read.
		expect(wrapper.find(DOWNLOAD).attributes('disabled')).toBeUndefined();
	});

	it('says the processing limit was reached when the AI budget refused the batch', () => {
		const wrapper = render(
			message({ virusVerdict: 'clean', attachmentIndexing: 'skipped_budget' })
		);

		const line = wrapper.find(NOT_INDEXED);
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('processing limit');
		// The budget refuses a BATCH — per-sender or global — so the line must not
		// blame the sender for an instance-wide limit.
		expect(line.text()).not.toContain('sender');
	});

	it('says a file was too large for the assistant to read', () => {
		const wrapper = render(
			message({ virusVerdict: 'clean', attachmentIndexing: 'skipped_too_large' })
		);

		const line = wrapper.find(NOT_INDEXED);
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('larger than the processing limit');
		// The bytes are here — only the reading was skipped.
		expect(wrapper.find(DOWNLOAD).attributes('disabled')).toBeUndefined();
	});

	it('says a file type is not one the assistant processes', () => {
		const wrapper = render(
			message({ virusVerdict: 'clean', attachmentIndexing: 'skipped_unsupported' })
		);

		const line = wrapper.find(NOT_INDEXED);
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('file types');
		expect(wrapper.find(DOWNLOAD).attributes('disabled')).toBeUndefined();
	});

	it('says the message carries more files than the assistant processes', () => {
		const wrapper = render(message({ virusVerdict: 'clean', attachmentIndexing: 'skipped_cap' }));

		const line = wrapper.find(NOT_INDEXED);
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('more attachments than it processes');
		// Every file is still listed and still downloadable — only some of them
		// were read, which is exactly what a row marked `indexed` would hide.
		expect(wrapper.find(DOWNLOAD).attributes('aria-disabled')).toBeUndefined();
	});

	it('warns that a refused file type was never scanned for malware either', () => {
		// The MTA's `/scan/attachment` runs its file-type gate BEFORE ClamAV, so
		// `invoice.pdf.exe` comes back refused with its bytes never compared to a
		// signature — while the row still offers a download. "We do not process
		// this type" is not the sentence a reader about to open it needs.
		const wrapper = render(
			message({ virusVerdict: 'skipped', attachmentIndexing: 'skipped_refused_type' })
		);

		const line = wrapper.find(NOT_INDEXED);
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('never scanned for malware');
		expect(line.text()).toContain('trust the sender');
		expect(wrapper.find(DOWNLOAD).attributes('disabled')).toBeUndefined();
	});

	it('says the files could not be processed when capture itself failed', () => {
		// Capture can throw after the row exists. An unmarked row renders exactly
		// like a message the assistant read cover to cover, which is the one
		// silent exit these markers exist to close.
		const wrapper = render(
			message({ virusVerdict: 'clean', attachmentIndexing: 'skipped_failed' })
		);

		const line = wrapper.find(NOT_INDEXED);
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('could not process');
		expect(wrapper.find(DOWNLOAD).attributes('disabled')).toBeUndefined();
	});

	it('says the sender could not be verified', () => {
		const wrapper = render(
			message({ virusVerdict: 'clean', attachmentIndexing: 'skipped_unverified' })
		);

		const line = wrapper.find(NOT_INDEXED);
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('could not be verified');
	});

	it('says the assistant knows only the names of some files', () => {
		// A `.docx`, an `.xlsx`, a scanned image: ingested, summarised and
		// embedded off a filename, because the extractor answers those types with
		// `[Word document: contract.docx]` and nothing more.
		const wrapper = render(
			message({ virusVerdict: 'clean', attachmentIndexing: 'indexed_placeholder' })
		);

		const line = wrapper.find(NOT_INDEXED);
		expect(line.exists()).toBe(true);
		expect(line.text()).toContain('knows the names');
		expect(wrapper.find(DOWNLOAD).attributes('aria-disabled')).toBeUndefined();
	});

	it('shows no notice line at all for a clean, indexed, still-stored message', () => {
		const wrapper = render(message({ virusVerdict: 'clean', attachmentIndexing: 'indexed' }));

		expect(wrapper.find('[data-testid="inbox-attachments-blocked"]').exists()).toBe(false);
		expect(wrapper.find(GONE).exists()).toBe(false);
		expect(wrapper.find(NOT_INDEXED).exists()).toBe(false);
		expect(wrapper.find(DOWNLOAD).attributes('disabled')).toBeUndefined();
	});
});
