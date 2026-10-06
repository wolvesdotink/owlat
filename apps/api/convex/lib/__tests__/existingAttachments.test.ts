/**
 * `readExistingAttachmentBytes` over a raw `.eml` (the "attach existing" path of
 * a Postbox draft and a Team inbox reply, for mail with no stored parts): the
 * copied attachment is the part's bytes exactly. The walk used to read the
 * message through `TextDecoder('latin1')`, which is windows-1252 and changed
 * bytes 0x80-0x9F of an 8-bit or binary part (#1279).
 */
import { describe, expect, it } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import { readExistingAttachmentBytes } from '../existingAttachments';

const BINARY_PART = [0x00, 0x41, 0x80, 0x99, 0x9f, 0xa0, 0xff];

function rawMessage(): Uint8Array<ArrayBuffer> {
	const encoder = new TextEncoder();
	return Uint8Array.from([
		...encoder.encode(
			[
				'Content-Type: multipart/mixed; boundary="b"',
				'',
				'--b',
				'Content-Type: text/plain; charset=utf-8',
				'Content-Transfer-Encoding: 8bit',
				'',
				'Price — “quoted” 5€',
				'--b',
				'Content-Type: application/octet-stream; name="blob.bin"',
				'Content-Disposition: attachment; filename="blob.bin"',
				'Content-Transfer-Encoding: binary',
				'',
				'',
			].join('\r\n')
		),
		...BINARY_PART,
		...encoder.encode('\r\n--b--\r\n'),
	]);
}

describe('readExistingAttachmentBytes', () => {
	it('copies a binary part out of the raw .eml byte for byte', async () => {
		const rawStorageId = 'raw_1' as Id<'_storage'>;
		const storage = {
			get: async (id: Id<'_storage'>) => (id === rawStorageId ? new Blob([rawMessage()]) : null),
		};

		const bytes = await readExistingAttachmentBytes(storage, {
			kind: 'rawEml',
			rawStorageId,
			partIndex: '0',
			filename: 'blob.bin',
		});

		expect([...(bytes ?? [])]).toEqual(BINARY_PART);
	});
});
