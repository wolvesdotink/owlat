// @vitest-environment happy-dom
/**
 * `useMimePartDownload` — the shared "fetch the raw .eml, extract one part,
 * hand the browser a Blob" half of both mail readers.
 *
 * The contract that matters here is the FAILURE one. Before it existed, a null
 * blob was a quiet nothing: the spinner stopped and no file ever arrived, which
 * is exactly the affordance defect this work is about.
 *
 * Proven here:
 *   - a found part downloads: an anchor is clicked with the file's name on it,
 *     and the spinner key is cleared afterwards
 *   - a raw message that would not load (released bytes, quarantined message,
 *     no proxy origin) toasts an error and clears the spinner
 *   - a part the message does not hold at all does the same
 *   - a thrown loader goes through `showOperationError`, so a dropped
 *     connection still reads as "check your connection"
 *   - the spinner key is the `messageId:partIndex` pair the row matches on
 *   - the line that failure renders, in the REAL catalog, promises nothing a
 *     retry cannot deliver
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { useMimePartDownload } from '../useMimePartDownload';
import en from '~~/i18n/locales/en.json';
import de from '~~/i18n/locales/de.json';

const FAILURE_KEY = 'components.inbox.inboxMessageAttachments.downloadFailed';

/** A one-part message whose single leaf is addressable at partIndex '0'. */
const RAW_EML = [
	'From: bob@example.com',
	'To: inbox@example.com',
	'Subject: one part',
	'Content-Type: multipart/mixed; boundary="bb"',
	'',
	'--bb',
	'Content-Type: text/plain; name="a.txt"',
	'Content-Disposition: attachment; filename="a.txt"',
	'Content-Transfer-Encoding: base64',
	'',
	Buffer.from('hello there').toString('base64'),
	'',
	'--bb--',
	'',
].join('\r\n');

let toasts: Array<[string, string | undefined]>;
let operationErrors: Array<[unknown, string]>;
let clicks: Array<{ download: string }>;

beforeEach(() => {
	toasts = [];
	operationErrors = [];
	clicks = [];

	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useToast', () => ({
		showToast: (message: string, tone?: string) => toasts.push([message, tone]),
	}));
	vi.stubGlobal('useOperationErrorToast', () => ({
		showOperationError: (err: unknown, key: string) => operationErrors.push([err, key]),
	}));
	vi.stubGlobal('ref', (initial: unknown) => ({ value: initial }));

	// happy-dom gives us a real anchor; the click is what we watch for.
	vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
		function (this: HTMLAnchorElement) {
			clicks.push({ download: this.download });
		}
	);
	globalThis.URL.createObjectURL = () => 'blob:mock';
	globalThis.URL.revokeObjectURL = () => undefined;
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const part = { filename: 'a.txt', contentType: 'text/plain', partIndex: '0' };

describe('useMimePartDownload', () => {
	it('downloads the extracted part under its own filename and clears the spinner', async () => {
		const { downloadingAttachment, handleAttachmentDownload } = useMimePartDownload({
			loadRaw: async () => RAW_EML,
			failureKey: FAILURE_KEY,
		});

		await handleAttachmentDownload('msg_1', part);

		expect(clicks).toEqual([{ download: 'a.txt' }]);
		expect(toasts).toEqual([]);
		expect(downloadingAttachment.value).toBeNull();
	});

	it('toasts an error when the raw message cannot be loaded at all', async () => {
		const { downloadingAttachment, handleAttachmentDownload } = useMimePartDownload({
			loadRaw: async () => null,
			failureKey: FAILURE_KEY,
		});

		await handleAttachmentDownload('msg_gone', part);

		expect(clicks).toEqual([]);
		expect(toasts).toEqual([[FAILURE_KEY, 'error']]);
		expect(downloadingAttachment.value).toBeNull();
	});

	it('does not promise a retry for a failure a retry cannot fix', () => {
		// The client refuses the click for swept bytes and hides the control for
		// quarantine, so almost everything that reaches this toast is a
		// CONFIGURATION state — INSTANCE_SECRET with no CONVEX_SITE_URL, a sealed
		// blob on an instance that lost its key, a part the metadata mis-addresses.
		// "Try again" is a promise none of those will ever keep. Asserted on the
		// real catalog, because the suite above only ever sees the key.
		const line = en.components.inbox.inboxMessageAttachments.downloadFailed;
		expect(line).toBe('That attachment could not be downloaded.');
		expect(line.toLowerCase()).not.toContain('try again');
		expect(de.components.inbox.inboxMessageAttachments.downloadFailed.toLowerCase()).not.toContain(
			'erneut versuchen'
		);
	});

	it('toasts an error when the message holds no such part at all', async () => {
		const { handleAttachmentDownload } = useMimePartDownload({
			loadRaw: async () => RAW_EML,
			failureKey: FAILURE_KEY,
		});

		// Neither the index nor the name resolves — `extractAttachmentAt` falls
		// back to a filename match, so the miss has to be total.
		await handleAttachmentDownload('msg_1', {
			filename: 'nowhere.bin',
			contentType: 'application/octet-stream',
			partIndex: '9',
		});

		expect(clicks).toEqual([]);
		expect(toasts).toEqual([[FAILURE_KEY, 'error']]);
	});

	it('routes a thrown loader through showOperationError so a dropped connection says so', async () => {
		const boom = new Error('network down');
		const { handleAttachmentDownload } = useMimePartDownload({
			loadRaw: async () => {
				throw boom;
			},
			failureKey: FAILURE_KEY,
		});

		await handleAttachmentDownload('msg_1', part);

		expect(toasts).toEqual([]);
		expect(operationErrors).toEqual([[boom, FAILURE_KEY]]);
	});

	it('keys the spinner on messageId:partIndex while the fetch is in flight', async () => {
		let release: (value: string) => void = () => {};
		const pending = new Promise<string>((resolve) => {
			release = resolve;
		});
		const { downloadingAttachment, handleAttachmentDownload } = useMimePartDownload({
			loadRaw: () => pending,
			failureKey: FAILURE_KEY,
		});

		const inFlight = handleAttachmentDownload('msg_7', part);
		expect(downloadingAttachment.value).toBe('msg_7:0');

		release(RAW_EML);
		await inFlight;
		expect(downloadingAttachment.value).toBeNull();
	});
});
