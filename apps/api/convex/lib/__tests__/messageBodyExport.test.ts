import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import {
	openAccountExportBodyContent,
	openBodyPreservingLegacyForContactExport,
	readMailMessageBodiesForAccountExport,
	readStoredInboundPartForContactExport,
} from '../messageBodyExport';
import { sealBodyAtWrite } from '../messageBody';
import { sealBytesAtRest } from '../atRestBodies';

const SECRET = 'message-export-test-secret-for-aes-gcm';

function storageWith(entries: Record<string, Uint8Array | string>) {
	return {
		get: vi.fn(async (storageId: Id<'_storage'>) => {
			const value = entries[storageId];
			if (value === undefined) return null;
			const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
			return new Blob([bytes as unknown as BlobPart]);
		}),
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('messageBodyExport', () => {
	it('preserves arbitrary RFC822 bytes with an explicit base64 contract', async () => {
		const raw = new Uint8Array([0, 255, 254, 128, 65, 13, 10]);
		const storage = storageWith({ raw: raw });

		const result = await readMailMessageBodiesForAccountExport(storage, {
			rawStorageId: 'raw' as Id<'_storage'>,
		});

		expect(result.rawMessageEncoding).toBe('base64');
		expect(
			Uint8Array.from(atob(result.rawMessage), (character) => character.charCodeAt(0))
		).toEqual(raw);
		expect(result.bodyAvailability.raw).toBe('available');
	});

	it('treats empty inline bodies as authoritative instead of reading stale blobs', async () => {
		const storage = storageWith({ text: 'stale text', html: 'stale html' });

		const result = await readMailMessageBodiesForAccountExport(storage, {
			rawStorageId: 'missing-raw' as Id<'_storage'>,
			textBodyInline: '',
			htmlBodyInline: '',
			textBodyStorageId: 'text' as Id<'_storage'>,
			htmlBodyStorageId: 'html' as Id<'_storage'>,
		});

		expect(result.textBody).toBe('');
		expect(result.htmlBody).toBe('');
		expect(result.bodyAvailability.text).toBe('available');
		expect(result.bodyAvailability.html).toBe('available');
		expect(storage.get).not.toHaveBeenCalledWith('text');
		expect(storage.get).not.toHaveBeenCalledWith('html');
	});

	it('quarantines sealed blobs when the key is unavailable but preserves legacy plaintext', async () => {
		vi.stubEnv('INSTANCE_SECRET', undefined);
		const encoder = new TextEncoder();
		const sealedRaw = await sealBytesAtRest(SECRET, encoder.encode('sealed raw'));
		const sealedText = await sealBytesAtRest(SECRET, encoder.encode('sealed text'));
		const storage = storageWith({
			raw: sealedRaw,
			text: sealedText,
			html: 'legacy html',
		});

		const result = await readMailMessageBodiesForAccountExport(storage, {
			rawStorageId: 'raw' as Id<'_storage'>,
			textBodyStorageId: 'text' as Id<'_storage'>,
			htmlBodyStorageId: 'html' as Id<'_storage'>,
		});

		expect(result.rawMessage).toBe('');
		expect(result.textBody).toBe('');
		expect(result.htmlBody).toBe('legacy html');
		expect(result.bodyAvailability).toEqual({
			raw: 'corrupt',
			text: 'corrupt',
			html: 'available',
		});
	});

	it('quarantines truncated values that retain a reserved envelope marker', async () => {
		vi.stubEnv('INSTANCE_SECRET', SECRET);
		const truncatedBlob = new Uint8Array([0x41, 0x52, 0x42, 0x4c, 0x42, 0x31, 0x01, 0x00]);
		const storage = storageWith({ raw: truncatedBlob, text: truncatedBlob });

		const result = await readMailMessageBodiesForAccountExport(storage, {
			rawStorageId: 'raw' as Id<'_storage'>,
			textBodyStorageId: 'text' as Id<'_storage'>,
			htmlBodyInline: 'atrest:1:truncated',
		});

		expect(result).toMatchObject({
			rawMessage: '',
			textBody: '',
			htmlBody: '',
			bodyAvailability: {
				raw: 'corrupt',
				text: 'corrupt',
				html: 'corrupt',
			},
		});
		expect(await openBodyPreservingLegacyForContactExport('atrest:99:damaged')).toBe('');
	});

	it('keeps ordinary legacy plaintext but quarantines authenticated envelope failures', async () => {
		vi.stubEnv('INSTANCE_SECRET', SECRET);
		expect(await openBodyPreservingLegacyForContactExport('ordinary legacy body')).toBe(
			'ordinary legacy body'
		);

		const sealed = await sealBodyAtWrite('sealed body');
		const parts = sealed.split(':');
		const ciphertext = Uint8Array.from(atob(parts[parts.length - 1]!), (character) =>
			character.charCodeAt(0)
		);
		ciphertext[ciphertext.length - 1] = ciphertext[ciphertext.length - 1]! ^ 1;
		parts[parts.length - 1] = btoa(String.fromCharCode(...ciphertext));
		const tampered = parts.join(':');

		expect(await openBodyPreservingLegacyForContactExport(tampered)).toBe('');
		expect(await openAccountExportBodyContent(tampered)).toEqual({
			content: '',
			availability: 'corrupt',
		});
	});

	it('charges a stored inbound part at its JSON size and omits what the budget cannot take', async () => {
		// Every quote escapes, so the returned JSON is twice the blob.
		const body = '"'.repeat(1000);
		const storage = storageWith({ part: body });
		const id = 'part' as Id<'_storage'>;

		const tight = { remainingBytes: 1500 };
		expect(await readStoredInboundPartForContactExport(storage, id, 1000, tight)).toEqual({
			content: undefined,
			availability: 'omitted',
		});
		expect(tight.remainingBytes).toBe(1500);

		const roomy = { remainingBytes: 5000 };
		expect(await readStoredInboundPartForContactExport(storage, id, 1000, roomy)).toEqual({
			content: body,
			availability: 'available',
		});
		expect(roomy.remainingBytes).toBe(5000 - 2002);

		// Larger than what is left: not even read.
		storage.get.mockClear();
		expect(
			(await readStoredInboundPartForContactExport(storage, id, 1000, { remainingBytes: 10 }))
				.availability
		).toBe('omitted');
		expect(storage.get).not.toHaveBeenCalled();
	});
});
