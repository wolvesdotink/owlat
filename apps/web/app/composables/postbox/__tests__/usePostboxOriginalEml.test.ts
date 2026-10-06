/**
 * "Download .eml": the file the user saves is the message's bytes exactly as
 * they were stored, headers and 8-bit parts included (#1279). The raw loader
 * reads the blob into a binary string and the download turns it back into
 * bytes; neither step may change a byte, 0x80-0x9F included.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRawEmlLoader } from '~/composables/rawEmlLoader';

/** A raw 8-bit header and body, and a binary part's bytes 0x80-0x9F. */
const MESSAGE = Uint8Array.from([
	...new TextEncoder().encode('Subject: Price — 5€\r\nContent-Transfer-Encoding: binary\r\n\r\n'),
	0x00,
	0x41,
	0x80,
	0x99,
	0x9f,
	0xa0,
	0xff,
]);

let saved: Blob[];
let toasts: string[];

beforeEach(() => {
	saved = [];
	toasts = [];
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useToast', () => ({ showToast: (message: string) => toasts.push(message) }));
	vi.stubGlobal(
		'loadRawEml',
		createRawEmlLoader(async () => 'https://blob.example.com/raw')
	);
	vi.stubGlobal('fetch', async () => ({
		ok: true,
		arrayBuffer: async () => MESSAGE.slice().buffer,
	}));
	vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
		saved.push(blob as Blob);
		return 'blob:message';
	});
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('usePostboxOriginalEml', () => {
	it('saves exactly the stored bytes', async () => {
		vi.resetModules();
		const { usePostboxOriginalEml } = await import('../usePostboxOriginalEml');
		const { downloadOriginal } = usePostboxOriginalEml();

		await downloadOriginal('msg_1');

		expect(toasts).toEqual([]);
		expect(saved).toHaveLength(1);
		expect([...new Uint8Array(await saved[0]!.arrayBuffer())]).toEqual([...MESSAGE]);
	});
});
