import { describe, expect, it, vi } from 'vitest';
import { detectMissingMailBlobs } from '../0043_detect_missing_mail_blobs';

describe('0043 missing mail blob audit', () => {
	it('counts distinct missing blobs and every affected row across page boundaries', async () => {
		const runQuery = vi
			.fn()
			.mockResolvedValueOnce({
				rows: [
					{ messageId: 'm1', mailboxId: 'mb', rawStorageId: 'shared-missing' },
					{ messageId: 'm2', mailboxId: 'mb', rawStorageId: 'shared-missing' },
				],
				cursor: 'next',
				isDone: false,
			})
			.mockResolvedValueOnce({
				rows: [
					{ messageId: 'm3', mailboxId: 'mb', rawStorageId: 'shared-missing' },
					{ messageId: 'm4', mailboxId: 'mb', rawStorageId: 'present' },
				],
				cursor: 'done',
				isDone: true,
			});
		const getMetadata = vi.fn(async (id: string) => (id === 'present' ? { size: 10 } : null));

		await expect(
			detectMissingMailBlobs({ runQuery, storage: { getMetadata } } as never)
		).resolves.toEqual({
			checkedBlobs: 2,
			missingBlobs: 1,
			missingMessages: 3,
			sample: [
				{ messageId: 'm1', mailboxId: 'mb', rawStorageId: 'shared-missing' },
				{ messageId: 'm2', mailboxId: 'mb', rawStorageId: 'shared-missing' },
				{ messageId: 'm3', mailboxId: 'mb', rawStorageId: 'shared-missing' },
			],
		});
		expect(getMetadata).toHaveBeenCalledTimes(2);
	});
});
