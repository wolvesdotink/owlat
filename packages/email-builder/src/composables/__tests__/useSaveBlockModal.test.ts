import { describe, it, expect, vi } from 'vitest';
import { computed, createApp } from 'vue';
import { useSaveBlockModal } from '../useSaveBlockModal';
import { EmailBuilderHandlersKey } from '../useEmailBuilderHandlers';
import type { EmailBuilderHandlers } from '../../types';
import type { EditorBlock } from '../../types';

function makeTextBlock(id: string): EditorBlock {
	return { id, type: 'text', content: { html: 'Hello' } };
}

/**
 * Run the composable inside an app context so its `inject` of the handlers
 * resolves to the supplied handlers (mirrors how EmailBuilder.vue provides them).
 */
function withHandlers<T>(handlers: EmailBuilderHandlers, fn: () => T): T {
	const app = createApp({ render: () => null });
	app.provide(EmailBuilderHandlersKey, handlers);
	return app.runWithContext(fn);
}

describe('useSaveBlockModal', () => {
	it('opens with a cleared name and closes back to a clean state', () => {
		const selectedBlock = computed<EditorBlock | null>(() => makeTextBlock('b1'));
		const modal = withHandlers(
			{ uploadImage: vi.fn(), savedBlocks: { fetch: vi.fn(), save: vi.fn() } },
			() => useSaveBlockModal({ selectedBlock }),
		);

		expect(modal.showSaveBlockModal.value).toBe(false);
		modal.saveBlockName.value = 'stale';
		modal.openSaveBlockModal();
		expect(modal.showSaveBlockModal.value).toBe(true);
		expect(modal.saveBlockName.value).toBe('');

		modal.saveBlockName.value = 'typed';
		modal.closeSaveBlockModal();
		expect(modal.showSaveBlockModal.value).toBe(false);
		expect(modal.saveBlockName.value).toBe('');
	});

	it('persists the selected block via savedBlocks.save and closes on success', async () => {
		const save = vi.fn().mockResolvedValue(undefined);
		const block = makeTextBlock('b1');
		const selectedBlock = computed<EditorBlock | null>(() => block);
		const modal = withHandlers(
			{ uploadImage: vi.fn(), savedBlocks: { fetch: vi.fn(), save } },
			() => useSaveBlockModal({ selectedBlock }),
		);

		modal.openSaveBlockModal();
		modal.saveBlockName.value = '  My Header  ';
		await modal.saveAsReusableBlock();

		expect(save).toHaveBeenCalledWith({ name: 'My Header', content: [block] });
		expect(modal.showSaveBlockModal.value).toBe(false);
		expect(modal.isSavingBlock.value).toBe(false);
	});

	it('does not call save when no block is selected or the name is blank', async () => {
		const save = vi.fn().mockResolvedValue(undefined);

		const noBlock = computed<EditorBlock | null>(() => null);
		const noBlockModal = withHandlers(
			{ uploadImage: vi.fn(), savedBlocks: { fetch: vi.fn(), save } },
			() => useSaveBlockModal({ selectedBlock: noBlock }),
		);
		noBlockModal.saveBlockName.value = 'name';
		await noBlockModal.saveAsReusableBlock();
		expect(save).not.toHaveBeenCalled();

		const block = computed<EditorBlock | null>(() => makeTextBlock('b1'));
		const blankNameModal = withHandlers(
			{ uploadImage: vi.fn(), savedBlocks: { fetch: vi.fn(), save } },
			() => useSaveBlockModal({ selectedBlock: block }),
		);
		blankNameModal.saveBlockName.value = '   ';
		await blankNameModal.saveAsReusableBlock();
		expect(save).not.toHaveBeenCalled();
	});

	it('stays open when the save handler rejects', async () => {
		const save = vi.fn().mockRejectedValue(new Error('boom'));
		const block = computed<EditorBlock | null>(() => makeTextBlock('b1'));
		const modal = withHandlers(
			{ uploadImage: vi.fn(), savedBlocks: { fetch: vi.fn(), save } },
			() => useSaveBlockModal({ selectedBlock: block }),
		);

		modal.openSaveBlockModal();
		modal.saveBlockName.value = 'My Header';
		await modal.saveAsReusableBlock();

		expect(save).toHaveBeenCalled();
		expect(modal.showSaveBlockModal.value).toBe(true);
		expect(modal.isSavingBlock.value).toBe(false);
	});
});
