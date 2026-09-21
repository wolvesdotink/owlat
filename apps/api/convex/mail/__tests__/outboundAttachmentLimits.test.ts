import { describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import type { DraftRow } from '../rfc822';
import { ATTACHMENT_COMPOSE_LIMITS, MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { bufferDraftAttachments } from '../outbound/build';

vi.mock('../mtaClient', () => ({
	getMtaConfig: vi.fn(),
	scanAttachmentBytes: vi.fn(async () => ({ kind: 'clean' })),
}));
function fixture(
	sizes: (number | null)[],
	options: { inline?: boolean; unusedInline?: boolean } = {}
) {
	const get = vi.fn(async () => new Blob(['hello']));
	const runQuery = vi.fn(async () => sizes);
	const ctx = { storage: { get }, runQuery } as unknown as ActionCtx;
	const draft = {
		bodyHtml: options.inline ? '<img data-inline-cid="part" src="blob:preview">' : '',
		attachments: sizes.map((_, index) => ({
			storageId: `storage-${index}`,
			filename: `${index}.txt`,
			contentType: 'text/plain',
			size: 1,
			isInline: Boolean(options.inline || options.unusedInline),
			contentId: 'part',
		})),
	} as unknown as DraftRow;
	return { ctx, draft, get, runQuery };
}
describe('legacy outbound attachment metadata preflight', () => {
	it('rejects a forged per-file size before loading any bytes', async () => {
		const f = fixture([MAX_ATTACHMENT_BYTES + 1]);
		await expect(bufferDraftAttachments(f.ctx, f.draft)).rejects.toThrow(
			'Attachment size limit exceeded'
		);
		expect(f.get).not.toHaveBeenCalled();
	});
	it('counts actual aggregate bytes even when every stored size field claims one byte', async () => {
		const f = fixture([ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes, 1]);
		await expect(bufferDraftAttachments(f.ctx, f.draft)).rejects.toThrow(
			'Attachment size limit exceeded'
		);
		expect(f.get).not.toHaveBeenCalled();
	});
	it('includes referenced inline images in the byte budget', async () => {
		const f = fixture([ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes + 1], { inline: true });
		await expect(bufferDraftAttachments(f.ctx, f.draft)).rejects.toThrow(
			'Attachment size limit exceeded'
		);
		expect(f.get).not.toHaveBeenCalled();
	});
	it('rejects excessive attachment counts before metadata or blob reads', async () => {
		const f = fixture(Array(ATTACHMENT_COMPOSE_LIMITS.maxCount + 1).fill(1));
		await expect(bufferDraftAttachments(f.ctx, f.draft)).rejects.toThrow('Too many attachments');
		expect(f.runQuery).not.toHaveBeenCalled();
		expect(f.get).not.toHaveBeenCalled();
	});
	it('preserves valid attachments and skips missing legacy blobs', async () => {
		const f = fixture([5, null]);
		const result = await bufferDraftAttachments(f.ctx, f.draft);
		expect(result.attachments).toHaveLength(1);
		expect(result.attachments[0]?.data.toString()).toBe('hello');
		expect(f.get).toHaveBeenCalledOnce();
	});
	it('prunes unused inline images before counting them', async () => {
		const f = fixture(Array(ATTACHMENT_COMPOSE_LIMITS.maxCount + 1).fill(1), {
			unusedInline: true,
		});
		f.runQuery.mockResolvedValue([]);
		expect((await bufferDraftAttachments(f.ctx, f.draft)).attachments).toEqual([]);
		expect(f.get).not.toHaveBeenCalled();
	});
});
