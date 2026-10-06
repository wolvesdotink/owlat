import { describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';
import type { DraftRow } from '../rfc822';
import { bufferDraftAttachments } from '../outbound/build';

/**
 * #1272: a reopened draft no longer shows its inline body image as a file chip,
 * but the image stays on the row. The message is built from the row, so it
 * carries the image for as long as the body shows it, beside the files.
 * (The composer side is `usePostboxComposeReopenAttachments.test.ts` in web.)
 */

vi.mock('../mtaClient', () => ({
	getMtaConfig: vi.fn(),
	scanAttachmentBytes: vi.fn(async () => ({ kind: 'clean' })),
}));

const CONTRACT = {
	storageId: 'storage_contract.pdf',
	filename: 'contract.pdf',
	contentType: 'application/pdf',
	size: 4_000,
	isInline: false,
};
const LOGO = {
	storageId: 'storage_logo.png',
	filename: 'logo.png',
	contentType: 'image/png',
	size: 500,
	isInline: true,
	contentId: 'logo@owlat.inline',
};
/** How the Simple editor stored an embedded image before #1285: a session blob: src. */
const LOGO_BODY =
	'<p>Attached.</p><p><img src="blob:http://localhost/preview" data-inline-cid="logo@owlat.inline"></p>';
/** How it stores one since #1285: the marker and no src at all. */
const LOGO_BODY_NO_SRC =
	'<p>Attached.</p><p><img data-inline-cid="logo@owlat.inline" style="max-width:100%;height:auto"></p>';

function reopenedDraft(bodyHtml: string) {
	const attachments = [CONTRACT, LOGO];
	const ctx = {
		storage: { get: vi.fn(async () => new Blob(['bytes'])) },
		runQuery: vi.fn(async () => attachments.map((a) => a.size)),
	} as unknown as ActionCtx;
	return { ctx, draft: { bodyHtml, attachments } as unknown as DraftRow };
}

describe('bufferDraftAttachments: a reopened draft with an inline body image', () => {
	it('sends the inline image the body shows, beside the file, as a cid: part', async () => {
		const { ctx, draft } = reopenedDraft(LOGO_BODY);
		const { inlinedHtml, attachments } = await bufferDraftAttachments(ctx, draft);

		expect(
			attachments.map(({ filename, isInline, contentId }) => ({ filename, isInline, contentId }))
		).toEqual([
			{ filename: 'contract.pdf', isInline: false, contentId: undefined },
			{ filename: 'logo.png', isInline: true, contentId: 'logo@owlat.inline' },
		]);
		expect(inlinedHtml).toContain('src="cid:logo@owlat.inline"');
	});

	it('sends the inline image of a body saved without a src (#1285)', async () => {
		const { ctx, draft } = reopenedDraft(LOGO_BODY_NO_SRC);
		const { inlinedHtml, attachments } = await bufferDraftAttachments(ctx, draft);

		expect(attachments.map((a) => [a.filename, a.isInline, a.contentId])).toEqual([
			['contract.pdf', false, undefined],
			['logo.png', true, 'logo@owlat.inline'],
		]);
		expect(inlinedHtml).toContain(
			'<img src="cid:logo@owlat.inline" style="max-width:100%;height:auto">'
		);
		expect(inlinedHtml).not.toContain('data-inline-cid');
	});

	it('leaves the image out once the body no longer shows it, and keeps the file', async () => {
		const { ctx, draft } = reopenedDraft('<p>Attached.</p>');
		const { attachments } = await bufferDraftAttachments(ctx, draft);

		expect(attachments.map((a) => a.filename)).toEqual(['contract.pdf']);
	});
});
