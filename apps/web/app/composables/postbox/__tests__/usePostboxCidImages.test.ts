// @vitest-environment happy-dom
/**
 * `usePostboxCidImages` — the body's inline `cid:` images, loaded from the
 * message's own parts as `data:` URLs.
 *
 * Proven here:
 *   - referenced image parts load and come back keyed by normalized Content-ID
 *   - `pending` holds while they load, so the body does not cache a render
 *     with holes in it
 *   - a part that fails to load (or is not an image) is left out
 *   - a part already resolved this session applies at once on the next open
 *   - switching to a message without inline images clears the previous map
 */
import { describe, it, expect, vi } from 'vitest';
import { ref, nextTick } from 'vue';
import { flushPromises } from '@vue/test-utils';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

import { usePostboxCidImages } from '../usePostboxCidImages';
import type { CidAttachment } from '~/utils/postboxCidImages';

const png = (contentId: string, partIndex = '2'): CidAttachment => ({
	filename: `${contentId}.png`,
	contentType: 'image/png',
	size: 10,
	partIndex,
	contentId: `<${contentId}>`,
});

const BODY = '<img src="cid:logo@a.example"><img src="cid:badge@a.example">';

/** Wait until the loads in flight have landed (FileReader settles on later tasks). */
async function settle(pending: { value: boolean }) {
	await nextTick();
	await flushPromises();
	await vi.waitFor(() => expect(pending.value).toBe(false));
}

describe('usePostboxCidImages', () => {
	it('loads referenced parts as data: URLs and holds pending meanwhile', async () => {
		const loadPart = vi.fn(async (_id: string, att: CidAttachment) =>
			att.contentId === '<badge@a.example>' ? null : new Blob(['png-bytes'], { type: 'image/png' })
		);
		const { urls, pending } = usePostboxCidImages(
			() => ({
				messageId: 'm1',
				html: BODY,
				attachments: [png('logo@a.example'), png('badge@a.example', '3')],
			}),
			{ loadPart }
		);
		expect(pending.value).toBe(true);
		await settle(pending);
		expect(pending.value).toBe(false);
		expect(loadPart).toHaveBeenCalledTimes(2);
		expect([...urls.value.keys()]).toEqual(['logo@a.example']);
		expect(urls.value.get('logo@a.example')).toMatch(/^data:image\/png;base64,/);
	});

	it('drops a part that is not an image', async () => {
		const loadPart = vi.fn(async () => new Blob(['<html>'], { type: 'text/html' }));
		const { urls, pending } = usePostboxCidImages(
			() => ({
				messageId: 'm2',
				html: BODY,
				attachments: [{ ...png('logo@a.example'), contentType: 'text/html' }],
			}),
			{ loadPart }
		);
		await settle(pending);
		// Not an image part, so it was never requested.
		expect(loadPart).not.toHaveBeenCalled();
		expect(urls.value.size).toBe(0);
	});

	it('resolves a part loaded earlier in the session without loading it again', async () => {
		const loadPart = vi.fn(async () => new Blob(['png'], { type: 'image/png' }));
		const source = () => ({
			messageId: 'm3',
			html: BODY,
			attachments: [png('logo@a.example')],
		});
		const first = usePostboxCidImages(source, { loadPart });
		await settle(first.pending);
		expect(loadPart).toHaveBeenCalledTimes(1);

		const again = usePostboxCidImages(source, { loadPart });
		expect(again.pending.value).toBe(false);
		expect(again.urls.value.has('logo@a.example')).toBe(true);
		expect(loadPart).toHaveBeenCalledTimes(1);
	});

	it('clears the map when the next message has no inline images', async () => {
		const loadPart = vi.fn(async () => new Blob(['png'], { type: 'image/png' }));
		const messageId = ref('m4');
		const { urls, pending } = usePostboxCidImages(
			() =>
				messageId.value === 'm4'
					? { messageId: 'm4', html: BODY, attachments: [png('logo@a.example')] }
					: { messageId: messageId.value, html: '<p>plain</p>', attachments: [] },
			{ loadPart }
		);
		await settle(pending);
		expect(urls.value.size).toBe(1);
		messageId.value = 'm5';
		await nextTick();
		expect(urls.value.size).toBe(0);
		expect(pending.value).toBe(false);
	});
});
