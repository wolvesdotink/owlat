import { describe, expect, it, vi } from 'vitest';
import { VCARD_IMPORT_BATCH_SIZE, VCARD_PHOTO_BATCH_SIZE } from '@owlat/shared/postboxVcardLimits';
import { importVcardFile } from '../postboxVcardTransfer';

const card = (n: number) =>
	`BEGIN:VCARD\r\nVERSION:3.0\r\nEMAIL:p${n}@example.com\r\nEND:VCARD\r\n`;
const vcf = (text: string, name = 'contacts.vcf') => new File([text], name, { type: 'text/vcard' });

describe('importVcardFile', () => {
	it('writes the entries in batches and sums what each wrote', async () => {
		const count = VCARD_IMPORT_BATCH_SIZE + 1;
		const text =
			Array.from({ length: count }, (_, n) => card(n)).join('') +
			'BEGIN:VCARD\r\nFN:No address\r\nEND:VCARD\r\n';
		const writeBatch = vi.fn(async (entries: unknown[]) => ({
			ok: true as const,
			result: { created: entries.length, merged: 0 },
		}));
		const outcome = await importVcardFile(vcf(text), writeBatch);
		expect(writeBatch.mock.calls.map(([entries]) => entries.length)).toEqual([
			VCARD_IMPORT_BATCH_SIZE,
			1,
		]);
		expect(outcome).toEqual({
			kind: 'done',
			created: count,
			merged: 0,
			skippedWithoutEmail: 1,
			isTruncated: false,
		});
	});

	it('stops at the first failed batch and keeps what was written', async () => {
		const text = Array.from({ length: VCARD_IMPORT_BATCH_SIZE * 3 }, (_, n) => card(n)).join('');
		const writeBatch = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, result: { created: 60, merged: 40 } })
			.mockResolvedValueOnce({ ok: false });
		const outcome = await importVcardFile(vcf(text), writeBatch);
		expect(writeBatch).toHaveBeenCalledTimes(2);
		expect(outcome).toMatchObject({ kind: 'stopped', created: 60, merged: 40 });
	});

	it('refuses a file that is not a vCard, or holds no address, without writing', async () => {
		const writeBatch = vi.fn();
		expect(
			await importVcardFile(new File([card(1)], 'audience.csv', { type: 'text/csv' }), writeBatch)
		).toEqual({
			kind: 'rejected',
			reason: 'wrong_type',
		});
		expect(
			await importVcardFile(vcf('BEGIN:VCARD\r\nFN:Nobody\r\nEND:VCARD\r\n'), writeBatch)
		).toEqual({ kind: 'rejected', reason: 'empty' });
		expect(writeBatch).not.toHaveBeenCalled();
	});

	it('sends the entries without their pictures and uploads the pictures after each batch', async () => {
		const jpeg = new Uint8Array(32);
		jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
		const base64 = Buffer.from(jpeg).toString('base64');
		const count = VCARD_PHOTO_BATCH_SIZE + 2;
		const text = Array.from(
			{ length: count },
			(_, n) =>
				`BEGIN:VCARD\r\nVERSION:3.0\r\nEMAIL:p${n}@example.com\r\nPHOTO;ENCODING=b;TYPE=JPEG:${base64}\r\nEND:VCARD\r\n`
		).join('');
		const writeBatch = vi.fn(async (entries: unknown[]) => ({
			ok: true as const,
			result: { created: entries.length, merged: 0 },
		}));
		const writePhotos = vi.fn(async (_photos: Array<{ email: string; base64: string }>) => ({
			ok: true,
		}));

		await importVcardFile(vcf(text), writeBatch, writePhotos);

		const [sent] = writeBatch.mock.calls[0]!;
		expect(sent.every((entry) => !('photo' in (entry as object)))).toBe(true);
		expect(writePhotos.mock.calls.map(([photos]) => photos.length)).toEqual([
			VCARD_PHOTO_BATCH_SIZE,
			2,
		]);
		expect(writePhotos.mock.calls[0]![0][0]).toEqual({ email: 'p0@example.com', base64 });
	});
});
