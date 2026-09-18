import { beforeEach, describe, expect, it, vi } from 'vitest';

const resealStoredBlob = vi.hoisted(() => vi.fn());
vi.mock('../../lib/sealedBlob', () => ({ resealStoredBlob }));

const { resealRowBlobs } = await import('../blobReseal');

beforeEach(() => {
	resealStoredBlob.mockReset();
});

describe('resealRowBlobs purge races', () => {
	it('reclaims a fresh blob when the last referencing row vanished before repoint', async () => {
		resealStoredBlob.mockResolvedValueOnce('fresh-raw').mockResolvedValue(null);
		const storage = { delete: vi.fn(async (_id: unknown) => undefined) };
		const runMutation = vi.fn(async () => ({ raw: false, text: false, html: false }));

		await expect(
			resealRowBlobs(
				{ storage, runMutation } as never,
				{ id: 'message', rawStorageId: 'old-raw' } as never
			)
		).resolves.toBe(true);

		expect(storage.delete).toHaveBeenCalledWith('fresh-raw');
	});

	it('reclaims every unpublished blob when the repoint mutation fails', async () => {
		resealStoredBlob
			.mockResolvedValueOnce('fresh-raw')
			.mockResolvedValueOnce('fresh-text')
			.mockResolvedValueOnce('fresh-html');
		const storage = { delete: vi.fn(async (_id: unknown) => undefined) };
		const runMutation = vi.fn(async () => {
			throw new Error('transaction conflict');
		});

		await expect(
			resealRowBlobs(
				{ storage, runMutation } as never,
				{
					id: 'message',
					rawStorageId: 'old-raw',
					textBodyStorageId: 'old-text',
					htmlBodyStorageId: 'old-html',
				} as never
			)
		).rejects.toThrow('transaction conflict');

		expect(storage.delete.mock.calls.map(([id]) => id).sort()).toEqual([
			'fresh-html',
			'fresh-raw',
			'fresh-text',
		]);
	});
});
