// Inserting a saved Block copies its stored content into the document, so the
// same saved Block inserted twice must not leave two Blocks sharing any id.
import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { childBlockLists } from '@owlat/shared/blockTree';
import { useSavedBlockPicker } from '../useSavedBlockPicker';
import type { EditorBlock, SavedBlock } from '../../types';

vi.mock('../useEmailBuilderHandlers', () => ({ useEmailBuilderHandlers: () => ({}) }));

const ids = (blocks: readonly EditorBlock[]): string[] =>
	blocks.flatMap((b) => [b.id, ...ids(childBlockLists(b).flat())]);

const savedHero: SavedBlock = {
	_id: 'saved-hero',
	name: 'Hero',
	usageCount: 0,
	content: JSON.stringify({
		blocks: [
			{
				id: 'hero',
				type: 'hero',
				content: {
					items: [
						{ id: 'hero-text', type: 'text', content: { html: 'Welcome' } },
						{
							id: 'hero-box',
							type: 'container',
							content: { items: [{ id: 'hero-btn', type: 'button', content: { text: 'Go' } }] },
						},
					],
				},
			},
		],
	}),
};

describe('useSavedBlockPicker', () => {
	it('gives every Block of each insertion fresh ids, children included', () => {
		const canvasBlocks = ref<EditorBlock[]>([]);
		const picker = useSavedBlockPicker({ canvasBlocks, selectedBlockId: ref(null) });

		picker.handleSavedBlockSelect(savedHero);
		picker.handleSavedBlockSelect(savedHero);

		expect(canvasBlocks.value).toHaveLength(2);
		const all = ids(canvasBlocks.value);
		expect(all).toHaveLength(8);
		expect(new Set(all).size).toBe(all.length);
		for (const stored of ['hero', 'hero-text', 'hero-box', 'hero-btn']) {
			expect(all).not.toContain(stored);
		}
	});

	it('links each insertion as its own group', () => {
		const canvasBlocks = ref<EditorBlock[]>([]);
		const picker = useSavedBlockPicker({ canvasBlocks, selectedBlockId: ref(null) });

		picker.handleSavedBlockSelect(savedHero);
		picker.handleSavedBlockSelect(savedHero);

		const [first, second] = canvasBlocks.value;
		expect(first!.savedBlockRef?.blockId).toBe('saved-hero');
		expect(second!.savedBlockRef?.blockId).toBe('saved-hero');
		expect(first!.savedBlockRef?.groupId).not.toBe(second!.savedBlockRef?.groupId);
	});
});
