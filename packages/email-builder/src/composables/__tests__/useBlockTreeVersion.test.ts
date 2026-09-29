import { describe, it, expect, vi } from 'vitest';
import { nextTick, ref, watch } from 'vue';
import { useBlockTreeVersion } from '../useBlockTreeVersion';
import { useBlockManagement } from '../useBlockManagement';
import { useLinkedBlocks } from '../useLinkedBlocks';
import { useHistory } from '../useHistory';
import { defaultTheme } from '../../defaults';
import type { ColumnsBlockContent, ContainerBlockContent, EditorBlock } from '../../types';

import '../../registry';

/**
 * The block-tree version replaces four deep watchers on the canvas (emit,
 * history, preview, the host's dirty flag). It has to go up on every change the
 * editor makes, or an edit is neither saved nor undoable, while looking only one
 * level into the tree. These tests pin both halves: what the shallow watcher
 * sees by itself, and that every in-place edit below a block reports itself.
 */

function text(id: string, html = 'Hello'): EditorBlock {
	return {
		id,
		type: 'text',
		content: { html, blockType: 'paragraph', fontSize: 16, textColor: '#000' },
	};
}

function columns(id: string): EditorBlock {
	return {
		id,
		type: 'columns',
		content: {
			columnCount: 2,
			ratio: 'equal',
			columns: [
				[{ id: 'c-1', type: 'text', content: { html: 'Left' } }],
				[{ id: 'c-2', type: 'text', content: { html: 'Right' } }],
			],
		} as unknown as ColumnsBlockContent,
	};
}

function container(id: string): EditorBlock {
	return {
		id,
		type: 'container',
		content: {
			items: [{ id: 'i-1', type: 'text', content: { html: 'Inside' } }],
		} as unknown as ContainerBlockContent,
	};
}

/** Counts the flushes a watcher on `version` would run, as the editor's do. */
function counted(blocks: EditorBlock[]) {
	const canvasBlocks = ref<EditorBlock[]>(blocks);
	const tree = useBlockTreeVersion(canvasBlocks);
	const runs = vi.fn();
	watch(tree.version, runs);
	return { canvasBlocks, tree, runs };
}

describe('useBlockTreeVersion', () => {
	it('goes up when the array is replaced, a block is swapped, or blocks move in or out', async () => {
		const { canvasBlocks, runs } = counted([text('a'), text('b')]);

		canvasBlocks.value = [text('a', 'new')];
		await nextTick();
		expect(runs).toHaveBeenCalledTimes(1);

		canvasBlocks.value[0] = {
			...canvasBlocks.value[0]!,
			content: { html: 'edited' },
		} as EditorBlock;
		await nextTick();
		expect(runs).toHaveBeenCalledTimes(2);

		canvasBlocks.value.push(text('c'));
		await nextTick();
		expect(runs).toHaveBeenCalledTimes(3);

		canvasBlocks.value.splice(0, 1);
		await nextTick();
		expect(runs).toHaveBeenCalledTimes(4);
	});

	it('does not walk into blocks: an in-place edit below the root needs bump()', async () => {
		const { canvasBlocks, tree, runs } = counted([text('a')]);

		(canvasBlocks.value[0]!.content as { html: string }).html = 'typed in place';
		await nextTick();
		expect(runs).not.toHaveBeenCalled();

		tree.bump();
		await nextTick();
		expect(runs).toHaveBeenCalledTimes(1);
	});

	it('runs a watcher once per flush when a root write and bump() coincide', async () => {
		const { canvasBlocks, tree, runs } = counted([text('a')]);
		canvasBlocks.value.push(text('b'));
		tree.bump();
		await nextTick();
		expect(runs).toHaveBeenCalledTimes(1);
	});
});

describe('in-place block edits report themselves', () => {
	function managed(blocks: EditorBlock[]) {
		const canvasBlocks = ref<EditorBlock[]>(blocks);
		const onTreeMutated = vi.fn();
		const mgmt = useBlockManagement({
			canvasBlocks,
			selectedBlockId: ref<string | null>(null),
			theme: ref(defaultTheme),
			onTreeMutated,
		});
		return { canvasBlocks, onTreeMutated, ...mgmt };
	}

	it('column items: add, delete, duplicate, and the column count', () => {
		const ctx = managed([columns('cols')]);

		ctx.handleAddItemToColumn('cols', 0, 'text');
		ctx.handleDeleteColumnItem('cols', 1, 'c-2');
		ctx.handleDuplicateColumnItem('cols', 0, 'c-1');
		ctx.handleColumnCountChange('cols', 3);
		expect(ctx.onTreeMutated).toHaveBeenCalledTimes(4);

		// No change, no report.
		ctx.handleColumnCountChange('cols', 3);
		ctx.handleDeleteColumnItem('cols', 0, 'missing');
		expect(ctx.onTreeMutated).toHaveBeenCalledTimes(4);
	});

	it('container items: delete and duplicate', () => {
		const ctx = managed([container('box')]);

		ctx.handleDuplicateContainerItem('box', 'i-1');
		ctx.handleDeleteContainerItem('box', 'i-1');
		expect(ctx.onTreeMutated).toHaveBeenCalledTimes(2);

		ctx.handleDeleteContainerItem('box', 'missing');
		expect(ctx.onTreeMutated).toHaveBeenCalledTimes(2);
	});

	it('detaching a linked block', () => {
		const linked: EditorBlock = {
			...text('a'),
			savedBlockRef: { blockId: 'saved-1', groupId: 'g-1', blockName: 'Footer' },
		};
		const canvasBlocks = ref<EditorBlock[]>([linked, text('b')]);
		const onTreeMutated = vi.fn();
		const { detachBlock } = useLinkedBlocks({ canvasBlocks, onTreeMutated });

		detachBlock('b');
		expect(onTreeMutated).not.toHaveBeenCalled();
		detachBlock('a');
		expect(onTreeMutated).toHaveBeenCalledTimes(1);
		expect(canvasBlocks.value[0]!.savedBlockRef).toBeUndefined();
	});
});

describe('useHistory with a block-tree version', () => {
	const DEBOUNCE = 2;
	const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
	const settle = async () => {
		await nextTick();
		await sleep(DEBOUNCE + 5);
		await nextTick();
	};

	it('records a change when the version moves, and only then', async () => {
		const blocks = ref<EditorBlock[]>([text('a', 'one')]);
		const version = ref(0);
		const history = useHistory(blocks, ref('Name'), ref('Subject'), {
			debounceMs: DEBOUNCE,
			blocksVersion: version,
		});
		expect(history.currentIndex.value).toBe(0);

		// A deep edit with no version bump: history no longer walks the tree.
		(blocks.value[0]!.content as { html: string }).html = 'two';
		await settle();
		expect(history.currentIndex.value).toBe(0);

		version.value++;
		await settle();
		expect(history.currentIndex.value).toBe(1);
	});
});
