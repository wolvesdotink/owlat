import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../_generated/dataModel';

const { fetchGuardedMock, scanMock } = vi.hoisted(() => ({
	fetchGuardedMock: vi.fn(),
	scanMock: vi.fn(),
}));
vi.mock('../../lib/ssrfGuard', () => ({ fetchGuarded: fetchGuardedMock }));
vi.mock('../../mail/mtaClient', () => ({
	getMtaConfig: () => ({}),
	scanAttachmentBytes: scanMock,
}));

const { resolveAttachments } = await import('../attachmentFetch');

const ownBlob = 'kg2own0000000000000000000000000' as Id<'_storage'>;

function storageWith(blobs: Record<string, string>) {
	return {
		get: vi.fn(async (id: Id<'_storage'>) => (id in blobs ? new Blob([blobs[id]!]) : null)),
	};
}

beforeEach(() => {
	fetchGuardedMock.mockReset();
	scanMock.mockReset().mockResolvedValue({ kind: 'clean' });
});

describe('resolveAttachments', () => {
	it('reads an own-storage ref from storage and never fetches its URL', async () => {
		const storage = storageWith({ [ownBlob]: 'Invoice #42' });
		const [resolved] = await resolveAttachments(storage, [
			{
				filename: 'invoice.txt',
				contentType: 'text/plain',
				url: 'https://storage.example.com/blob',
				storageId: ownBlob,
			},
		]);
		expect(new TextDecoder().decode(resolved!.content)).toBe('Invoice #42');
		expect(resolved).toMatchObject({ filename: 'invoice.txt', contentType: 'text/plain' });
		expect(fetchGuardedMock).not.toHaveBeenCalled();
		// Still scanned, like every other outbound attachment.
		expect(scanMock).toHaveBeenCalledTimes(1);
	});

	it('fails the send when an own-storage blob is gone', async () => {
		await expect(
			resolveAttachments(storageWith({}), [{ filename: 'gone.txt', url: '', storageId: ownBlob }])
		).rejects.toThrow(/"gone.txt" is no longer stored/);
	});

	it('still fetches a caller-supplied URL through the SSRF guard', async () => {
		fetchGuardedMock.mockResolvedValue(new Response('remote bytes'));
		const [resolved] = await resolveAttachments(storageWith({}), [
			{ filename: 'remote.txt', url: 'https://files.example.com/remote.txt' },
		]);
		expect(new TextDecoder().decode(resolved!.content)).toBe('remote bytes');
		expect(fetchGuardedMock).toHaveBeenCalledWith(
			'https://files.example.com/remote.txt',
			expect.objectContaining({ protocols: ['https:'] })
		);
	});

	it('blocks a file the malware scan flags', async () => {
		scanMock.mockResolvedValue({ kind: 'infected', reason: 'Eicar-Test-Signature' });
		await expect(
			resolveAttachments(storageWith({ [ownBlob]: 'x' }), [
				{ filename: 'bad.txt', url: '', storageId: ownBlob },
			])
		).rejects.toThrow(/blocked by malware scan/);
	});
});
