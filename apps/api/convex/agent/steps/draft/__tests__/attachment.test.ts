/**
 * The draft step's attachment suggestion: the owner's answer to a file question
 * stands over the step's own file search.
 */

import { describe, it, expect, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { draftAttachmentPatch } from '../attachment';
import type { Id } from '../../../../_generated/dataModel';

const ownerPick = {
	query: 'signed contract',
	ambiguous: false,
	candidates: [
		{
			fileId: 'file_pick' as Id<'semanticFiles'>,
			storageId: 'store_pick' as Id<'_storage'>,
			filename: 'contract-signed.pdf',
			mimeType: 'application/pdf',
			fileSize: 2048,
			score: 1,
		},
	],
};

function searchCtx(files: unknown[]) {
	const runAction = vi.fn(async (ref: unknown) => {
		const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
		if (name.includes('semanticSearch')) return files;
		throw new Error(`unexpected runAction: ${name}`);
	});
	return { ctx: { runAction } as unknown as Parameters<typeof draftAttachmentPatch>[0], runAction };
}

const REQUEST = 'Hi, can you send me the signed contract?';
const otherFile = {
	_id: 'file_other',
	storageId: 'store_other',
	filename: 'contract-draft.pdf',
	mimeType: 'application/pdf',
	fileSize: 100,
	_score: 0.9,
};

describe('draftAttachmentPatch', () => {
	it("keeps the owner's pick and never searches again", async () => {
		const { ctx, runAction } = searchCtx([otherFile]);
		const patch = await draftAttachmentPatch(ctx, REQUEST, undefined, ownerPick);
		expect(patch).toEqual({ attachmentSuggestions: ownerPick });
		expect(runAction).not.toHaveBeenCalled();
	});

	it('suggests nothing when the owner answered without a file', async () => {
		const { ctx, runAction } = searchCtx([otherFile]);
		expect(await draftAttachmentPatch(ctx, REQUEST, undefined, null)).toEqual({});
		expect(runAction).not.toHaveBeenCalled();
	});

	it('searches Files as before when no file question was answered', async () => {
		const { ctx, runAction } = searchCtx([otherFile]);
		const patch = await draftAttachmentPatch(ctx, REQUEST, undefined);
		expect(runAction).toHaveBeenCalledOnce();
		expect(patch).toMatchObject({
			attachmentSuggestions: { ambiguous: false, candidates: [{ fileId: 'file_other' }] },
		});
	});
});
