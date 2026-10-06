// @vitest-environment happy-dom
/**
 * #1285: the composer asks for a draft's inline image URLs once Convex auth is
 * confirmed and it has a draft row whose body holds inline images, hands the
 * editor a Content-ID → URL map, and renews the expiring `/sealed-blob` URLs
 * before they run out: timed from the lifetime the server reports, never from
 * the device clock, and once when a slept tab wakes past its renewal time.
 *
 * Every trigger goes through one entry point, so a timer, a wake and a focus
 * landing together start one request, and backoff holds against all of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { usePostboxDraftInlineImages } from '../usePostboxDraftInlineImages';

vi.mock('@owlat/api', () => ({
	api: { mail: { draftInlineImages: { urls: 'draftInlineImages.urls' } } },
}));

const MIN = 60_000;
const HOUR = 60 * MIN;
const CID = 'chart@owlat.inline';
const IMAGE_BODY = `<p><img data-inline-cid="${CID}" style="max-width:100%"></p>`;
const DRAFT = 'draft_1' as Id<'mailDrafts'>;

/**
 * What the server answers: a URL whose `exp` is on the server's clock (the
 * test's `Date.now()`), and its lifetime.
 */
const part = (n: number, cid = CID) => ({
	contentId: cid,
	url: `https://deploy.convex.site/sealed-blob?id=s${n}&ct=image%2Fpng&exp=${Date.now() + HOUR}&sig=x&c=1`,
	expiresInMs: HOUR,
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

/** Let the auth wait and the mint promise settle. */
const settle = async () => {
	for (let i = 0; i < 6; i++) await Promise.resolve();
	await nextTick();
};

let scope: ReturnType<typeof effectScope>;
function setup(
	draftId: Id<'mailDrafts'> | null,
	body: string,
	mint: ReturnType<typeof vi.fn>,
	opts: { now?: () => number; whenAuthenticated?: ReturnType<typeof vi.fn> } = {}
) {
	const draft = ref(draftId);
	const html = ref(body);
	scope = effectScope();
	const sources = scope.run(() =>
		usePostboxDraftInlineImages(draft, html, {
			mint: mint as never,
			whenAuthenticated: (opts.whenAuthenticated ?? (async () => true)) as never,
			now: opts.now,
		})
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
		const mint = vi.fn(async () => [part(1)]);
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
		const { sources } = setup(
			DRAFT,
			IMAGE_BODY,
			vi.fn(async () => [part(1)])
		);
		await settle();
		expect(sources.value.urls.get(CID)).toContain('id=s1&');
	});

	it('waits for Convex auth before it asks', async () => {
		let authenticate!: (ok: boolean) => void;
		const whenAuthenticated = vi.fn(
			() => new Promise<boolean>((resolve) => (authenticate = resolve))
		);
		const mint = vi.fn(async () => [part(1)]);
		const { sources } = setup(DRAFT, IMAGE_BODY, mint, { whenAuthenticated });
		await settle();
		expect(mint).not.toHaveBeenCalled();

		authenticate(true);
		await settle();
		expect(mint).toHaveBeenCalledTimes(1);
		expect(sources.value.urls.get(CID)).toContain('id=s1&');
	});

	it('asks again after an empty answer, with the body unchanged', async () => {
		const mint = vi
			.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValue([part(2)]);
		const { sources } = setup(DRAFT, IMAGE_BODY, mint);
		await settle();
		expect(sources.value.urls.has(CID)).toBe(false);

		await vi.advanceTimersByTimeAsync(15_000);
		await settle();
		expect(mint).toHaveBeenCalledTimes(2);
		expect(sources.value.urls.get(CID)).toContain('id=s2&');
	});

	it('backs off while an image stays unresolved, up to five minutes', async () => {
		const mint = vi.fn(async () => []);
		setup(DRAFT, IMAGE_BODY, mint);
		await settle();
		const askedAt = async (ms: number) => {
			await vi.advanceTimersByTimeAsync(ms);
			await settle();
			return mint.mock.calls.length;
		};
		expect(await askedAt(15_000)).toBe(2);
		expect(await askedAt(30_000)).toBe(3);
		expect(await askedAt(60_000)).toBe(4);
		expect(await askedAt(120_000)).toBe(5);
		expect(await askedAt(240_000)).toBe(6);
		expect(await askedAt(299_000)).toBe(6);
		expect(await askedAt(1_000)).toBe(7);
		expect(await askedAt(300_000)).toBe(8);
	});

	it('keeps the URLs it has when an ask fails, and tries again', async () => {
		const mint = vi
			.fn()
			.mockResolvedValueOnce([part(1)])
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValue([part(3)]);
		const { sources } = setup(DRAFT, IMAGE_BODY, mint);
		await settle();

		await vi.advanceTimersByTimeAsync(50 * MIN);
		await settle();
		expect(mint).toHaveBeenCalledTimes(2);
		expect(sources.value.urls.get(CID)).toContain('id=s1&');

		await vi.advanceTimersByTimeAsync(15_000);
		await settle();
		expect(mint).toHaveBeenCalledTimes(3);
		expect(sources.value.urls.get(CID)).toContain('id=s3&');
	});

	it.each([
		['10 minutes behind', -10 * MIN],
		['10 minutes ahead', 10 * MIN],
	])('renews before the real expiry with the device clock %s', async (_label, skew) => {
		let n = 0;
		const mint = vi.fn(async () => [part(++n)]);
		const { sources } = setup(DRAFT, IMAGE_BODY, mint, { now: () => Date.now() + skew });
		await settle();

		// The server's hour runs out at 60 minutes, whatever the device clock says.
		await vi.advanceTimersByTimeAsync(50 * MIN);
		await settle();
		expect(mint).toHaveBeenCalledTimes(2);
		expect(sources.value.urls.get(CID)).toContain('id=s2&');
	});

	it('renews at once when a tab wakes up past its renewal time', async () => {
		let n = 0;
		const mint = vi.fn(async () => [part(++n)]);
		const { sources } = setup(DRAFT, IMAGE_BODY, mint);
		await settle();

		// Asleep for two hours: the clock moved on, no timer ran.
		vi.setSystemTime(Date.now() + 2 * HOUR);
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(mint).toHaveBeenCalledTimes(2);
		expect(sources.value.urls.get(CID)).toContain('id=s2&');

		// Waking early changes nothing.
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(mint).toHaveBeenCalledTimes(2);
	});

	it('starts one request for a timer, a wake and a focus that land while one is in flight', async () => {
		const pending = deferred<ReturnType<typeof part>[]>();
		const mint = vi
			.fn()
			.mockResolvedValueOnce([part(1)])
			.mockReturnValueOnce(pending.promise);
		const { sources } = setup(DRAFT, IMAGE_BODY, mint);
		await settle();

		await vi.advanceTimersByTimeAsync(50 * MIN);
		expect(mint).toHaveBeenCalledTimes(2);
		vi.setSystemTime(Date.now() + 2 * HOUR);
		document.dispatchEvent(new Event('visibilitychange'));
		window.dispatchEvent(new Event('focus'));
		await vi.advanceTimersByTimeAsync(10 * MIN);
		expect(mint).toHaveBeenCalledTimes(2);

		pending.resolve([part(2)]);
		await settle();
		expect(sources.value.urls.get(CID)).toContain('id=s2&');
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(mint).toHaveBeenCalledTimes(2);
	});

	it('asks once on an overdue wake, however many wake events follow', async () => {
		const pending = deferred<ReturnType<typeof part>[]>();
		const mint = vi
			.fn()
			.mockResolvedValueOnce([part(1)])
			.mockReturnValueOnce(pending.promise);
		setup(DRAFT, IMAGE_BODY, mint);
		await settle();

		vi.setSystemTime(Date.now() + 3 * HOUR);
		document.dispatchEvent(new Event('visibilitychange'));
		window.dispatchEvent(new Event('focus'));
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(mint).toHaveBeenCalledTimes(2);
		pending.resolve([part(2)]);
		await settle();
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(mint).toHaveBeenCalledTimes(2);
	});

	it('does not ask again on focus during backoff after a failed renewal', async () => {
		const mint = vi
			.fn()
			.mockResolvedValueOnce([part(1)])
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValue([part(3)]);
		setup(DRAFT, IMAGE_BODY, mint);
		await settle();

		// Woken long past the renewal time; the renewal fails.
		vi.setSystemTime(Date.now() + 2 * HOUR);
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(mint).toHaveBeenCalledTimes(2);

		for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('focus'));
		await settle();
		expect(mint).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(15_000);
		await settle();
		expect(mint).toHaveBeenCalledTimes(3);
	});

	it('asks at once for an image added during backoff, but never alongside a request', async () => {
		const pending = deferred<ReturnType<typeof part>[]>();
		const mint = vi
			.fn()
			.mockResolvedValueOnce([])
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValue([part(3), part(3, 'third@owlat.inline')]);
		const { html } = setup(DRAFT, IMAGE_BODY, mint);
		await settle();
		expect(mint).toHaveBeenCalledTimes(1);

		// In backoff (15 s): a new image asks now.
		html.value += '<p><img data-inline-cid="second@owlat.inline"></p>';
		await settle();
		expect(mint).toHaveBeenCalledTimes(2);

		// Another one while that request is out waits for it, then asks.
		html.value += '<p><img data-inline-cid="third@owlat.inline"></p>';
		await settle();
		expect(mint).toHaveBeenCalledTimes(2);
		pending.resolve([part(2), part(2, 'second@owlat.inline')]);
		await settle();
		expect(mint).toHaveBeenCalledTimes(3);
	});

	it("shows none of draft A's URLs on draft B, even when B's answer is empty", async () => {
		const mint = vi.fn(async (id: string) => (id === DRAFT ? [part(1)] : []));
		const { draft, sources } = setup(DRAFT, IMAGE_BODY, mint);
		await settle();
		expect(sources.value.urls.get(CID)).toContain('id=s1&');

		draft.value = 'draft_2' as Id<'mailDrafts'>;
		// Cleared in the pre-render flush, before B's request has even started.
		await nextTick();
		expect(sources.value.urls.has(CID)).toBe(false);
		await settle();
		expect(mint).toHaveBeenLastCalledWith('draft_2');
		expect(sources.value.urls.has(CID)).toBe(false);
	});

	it("drops draft A's answer when it arrives after the switch to B", async () => {
		const forA = deferred<ReturnType<typeof part>[]>();
		const mint = vi.fn((id: string) => (id === DRAFT ? forA.promise : Promise.resolve([])));
		const { draft, sources } = setup(DRAFT, IMAGE_BODY, mint);
		await settle();

		draft.value = 'draft_2' as Id<'mailDrafts'>;
		await settle();
		forA.resolve([part(1)]);
		await settle();
		expect(sources.value.urls.has(CID)).toBe(false);
	});

	it('does not count putting back a known image as new: undo after delete waits out the backoff', async () => {
		const mint = vi
			.fn()
			.mockResolvedValueOnce([part(1)])
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValue([part(3)]);
		const { html } = setup(DRAFT, IMAGE_BODY, mint);
		await settle();
		// The renewal fails: 15 s of backoff.
		await vi.advanceTimersByTimeAsync(50 * MIN);
		await settle();
		expect(mint).toHaveBeenCalledTimes(2);

		for (let i = 0; i < 20; i++) {
			html.value = '<p>Deleted.</p>';
			await settle();
			html.value = IMAGE_BODY;
			await settle();
		}
		expect(mint).toHaveBeenCalledTimes(2);

		await vi.advanceTimersByTimeAsync(15_000);
		await settle();
		expect(mint).toHaveBeenCalledTimes(3);
	});

	it('asks for five images added in quick succession in at most two requests', async () => {
		const pending = deferred<ReturnType<typeof part>[]>();
		const mint = vi
			.fn()
			.mockResolvedValueOnce([part(1)])
			.mockReturnValueOnce(pending.promise)
			.mockResolvedValue([part(3)]);
		const { html } = setup(DRAFT, IMAGE_BODY, mint);
		await settle();
		expect(mint).toHaveBeenCalledTimes(1);

		for (let i = 1; i <= 5; i++) {
			html.value += `<p><img data-inline-cid="new-${i}@owlat.inline"></p>`;
			await settle();
		}
		pending.resolve([part(2)]);
		await settle();
		await vi.advanceTimersByTimeAsync(1_000);
		await settle();
		expect(mint.mock.calls.length - 1).toBeLessThanOrEqual(2);
		expect(mint.mock.calls.length - 1).toBeGreaterThanOrEqual(1);
	});

	it('names the draft its URLs belong to', async () => {
		const { draft, sources } = setup(
			DRAFT,
			IMAGE_BODY,
			vi.fn(async () => [part(1)])
		);
		await settle();
		expect(sources.value.scope).toBe(DRAFT);
		draft.value = 'draft_2' as Id<'mailDrafts'>;
		await nextTick();
		expect(sources.value.scope).toBe('draft_2');
	});

	it('does not renew a URL that carries no lifetime', async () => {
		const mint = vi.fn(async () => [{ contentId: CID, url: 'https://storage.example/plain' }]);
		setup(DRAFT, IMAGE_BODY, mint);
		await settle();
		await vi.advanceTimersByTimeAsync(3 * HOUR);
		expect(mint).toHaveBeenCalledTimes(1);
	});

	it('stops renewing once the composer is gone', async () => {
		const mint = vi.fn(async () => [part(1)]);
		setup(DRAFT, IMAGE_BODY, mint);
		await settle();
		scope.stop();
		await vi.advanceTimersByTimeAsync(2 * HOUR);
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(mint).toHaveBeenCalledTimes(1);
	});
});
