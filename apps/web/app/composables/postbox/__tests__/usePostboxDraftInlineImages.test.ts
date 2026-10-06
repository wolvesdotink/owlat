// @vitest-environment happy-dom
/**
 * #1285: the composer asks for a draft's inline image URLs only while it has a
 * draft row and its body holds an inline image, and hands the editor a
 * Content-ID → URL map.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, shallowRef } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import { usePostboxDraftInlineImages } from '../usePostboxDraftInlineImages';

vi.mock('@owlat/api', () => ({
	api: { mail: { draftInlineImages: { urls: 'draftInlineImages.urls' } } },
}));

type Args = { draftId: string } | 'skip';
let argsOf: () => Args;
const data = shallowRef<Array<{ contentId: string; url: string }> | undefined>(undefined);

vi.stubGlobal('useConvexQuery', (query: string, args: () => Args) => {
	expect(query).toBe('draftInlineImages.urls');
	argsOf = args;
	return { data };
});

afterEach(() => {
	data.value = undefined;
});

const IMAGE_BODY = '<p><img data-inline-cid="chart@owlat.inline"></p>';

describe('usePostboxDraftInlineImages', () => {
	it('asks only for a saved draft whose body holds an inline image', () => {
		const draftId = ref<Id<'mailDrafts'> | null>(null);
		const body = ref(IMAGE_BODY);
		usePostboxDraftInlineImages(draftId, body);

		expect(argsOf()).toBe('skip');
		draftId.value = 'draft_1' as Id<'mailDrafts'>;
		expect(argsOf()).toEqual({ draftId: 'draft_1' });
		body.value = '<p>No image any more.</p>';
		expect(argsOf()).toBe('skip');
	});

	it('maps each Content-ID to its URL', async () => {
		const sources = usePostboxDraftInlineImages(
			ref('draft_1' as Id<'mailDrafts'>),
			ref(IMAGE_BODY)
		);
		expect(sources.value.size).toBe(0);

		data.value = [{ contentId: 'chart@owlat.inline', url: 'https://storage.owlat.example/c' }];
		await nextTick();
		expect(sources.value.get('chart@owlat.inline')).toBe('https://storage.owlat.example/c');
	});
});
