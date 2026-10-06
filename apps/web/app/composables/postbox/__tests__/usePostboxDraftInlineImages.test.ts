// @vitest-environment happy-dom
/**
 * #1285: the composer asks for a draft's inline image URLs when it has a draft
 * row whose body holds inline images, hands the editor a Content-ID → URL map,
 * and asks again before the expiring `/sealed-blob` URLs run out, so an editor
 * left open for hours keeps showing its images.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { usePostboxDraftInlineImages } from '../usePostboxDraftInlineImages';

vi.mock('@owlat/api', () => ({
	api: { mail: { draftInlineImages: { urls: 'draftInlineImages.urls' } } },
}));

const HOUR = 60 * 60 * 1000;
const CID = 'chart@owlat.inline';
const IMAGE_BODY = `<p><img data-inline-cid="${CID}" style="max-width:100%"></p>`;
const DRAFT = 'draft_1' as Id<'mailDrafts'>;

/** A minted proxy URL the way the server writes it, expiring in an hour. */
function proxyUrl(n: number) {
	return `https://deploy.convex.site/sealed-blob?id=s${n}&ct=image%2Fpng&exp=${Date.now() + HOUR}&sig=x&c=1`;
}

/** Let the mint promise settle. */
const settle = async () => {
	for (let i = 0; i < 4; i++) await Promise.resolve();
	await nextTick();
};

let scope: ReturnType<typeof effectScope>;
function setup(draftId: Id<'mailDrafts'> | null, body: string, mint: ReturnType<typeof vi.fn>) {
	const draft = ref(draftId);
	const html = ref(body);
	scope = effectScope();
	const sources = scope.run(() =>
		usePostboxDraftInlineImages(draft, html, { mint: mint as never })
	)!;
	return { draft, html, sources };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(Date.parse('2026-10-06T09:00:00Z'));
});

afterEach(() => {
	scope?.stop();
	vi.useRealTimers();
});

describe('usePostboxDraftInlineImages', () => {
	it('asks only for a saved draft whose body holds an inline image', async () => {
		const mint = vi.fn(async () => [{ contentId: CID, url: proxyUrl(1) }]);
		const { draft, html } = setup(null, IMAGE_BODY, mint);
		await settle();
		expect(mint).not.toHaveBeenCalled();

		draft.value = DRAFT;
		await settle();
		expect(mint).toHaveBeenCalledWith(DRAFT);

		// Typing does not ask again; a new image does.
		html.value = IMAGE_BODY + '<p>More text</p>';
		await settle();
		expect(mint).toHaveBeenCalledTimes(1);
		html.value += '<p><img data-inline-cid="second@owlat.inline"></p>';
		await settle();
		expect(mint).toHaveBeenCalledTimes(2);
	});

	it('maps each Content-ID to its URL', async () => {
		const url = proxyUrl(1);
		const { sources } = setup(
			DRAFT,
			IMAGE_BODY,
			vi.fn(async () => [{ contentId: CID, url }])
		);
		await settle();
		expect(sources.value.get(CID)).toBe(url);
	});

	it('renews the URLs a minute before they expire', async () => {
		let n = 0;
		const mint = vi.fn(async () => [{ contentId: CID, url: proxyUrl(++n) }]);
		const { sources } = setup(DRAFT, IMAGE_BODY, mint);
		await settle();
		const first = sources.value.get(CID);

		await vi.advanceTimersByTimeAsync(HOUR - 61_000);
		expect(mint).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1_000);
		await settle();
		expect(mint).toHaveBeenCalledTimes(2);
		expect(sources.value.get(CID)).not.toBe(first);
		expect(sources.value.get(CID)).toContain('id=s2');

		// And again an hour later: an editor left open keeps its images.
		await vi.advanceTimersByTimeAsync(HOUR);
		await settle();
		expect(mint).toHaveBeenCalledTimes(3);
	});

	it('keeps the URLs it has when an ask fails, and tries again a minute later', async () => {
		const url = proxyUrl(1);
		const mint = vi
			.fn()
			.mockResolvedValueOnce([{ contentId: CID, url }])
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValue([{ contentId: CID, url: proxyUrl(3) }]);
		const { sources } = setup(DRAFT, IMAGE_BODY, mint);
		await settle();

		await vi.advanceTimersByTimeAsync(HOUR - 60_000);
		await settle();
		expect(mint).toHaveBeenCalledTimes(2);
		expect(sources.value.get(CID)).toBe(url);

		await vi.advanceTimersByTimeAsync(60_000);
		await settle();
		expect(mint).toHaveBeenCalledTimes(3);
		expect(sources.value.get(CID)).toContain('id=s3');
	});

	it('does not renew a URL that carries no expiry', async () => {
		const mint = vi.fn(async () => [{ contentId: CID, url: 'https://storage.example/plain' }]);
		setup(DRAFT, IMAGE_BODY, mint);
		await settle();
		await vi.advanceTimersByTimeAsync(3 * HOUR);
		expect(mint).toHaveBeenCalledTimes(1);
	});

	it('stops renewing once the composer is gone', async () => {
		const mint = vi.fn(async () => [{ contentId: CID, url: proxyUrl(1) }]);
		setup(DRAFT, IMAGE_BODY, mint);
		await settle();
		scope.stop();
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		expect(mint).toHaveBeenCalledTimes(1);
	});
});
