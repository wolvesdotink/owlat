import { ref, watch } from 'vue';
import { normalizeBlockTreeIds } from '@owlat/shared/blockTree';
import type { EditorBlock, EmailBuilderConfig } from '../../types';
import { useBlockTreeVersion } from '../useBlockTreeVersion';

/** The EmailBuilder props the editing state syncs with. */
interface BuilderModelProps {
	blocks: EditorBlock[];
	subject: string;
	name: string;
	backgroundColor?: string;
	config?: EmailBuilderConfig;
}

/** The EmailBuilder `update:*` events the editing state emits. */
interface BuilderModelEmit {
	(e: 'update:blocks', value: EditorBlock[]): void;
	(e: 'update:subject', value: string): void;
	(e: 'update:name', value: string): void;
	(e: 'update:backgroundColor', value: string): void;
}

/**
 * Blocks entering the canvas, with every id present and unique. The canvas
 * keys Blocks by id, so two with one id (a pasted, imported or hand-edited
 * document) sent it into a recursive update loop. The first
 * occurrence keeps its id; the repair is deterministic, so a host re-pushing
 * the same stored document still matches what the builder emitted, and the
 * server can tell which id each copy got and carry its translation overlay
 * over when the document is saved (`carryRenewedBlockOverlays`).
 */
export function canvasBlocksOf(blocks: readonly EditorBlock[]): EditorBlock[] {
	return normalizeBlockTreeIds(blocks, { renewRepeated: true });
}

/**
 * The builder's local editing state (blocks, name, subject, background), kept
 * in sync with its v-model props both ways.
 */
export function useBuilderModel(props: BuilderModelProps, emit: BuilderModelEmit) {
	// ---------------------------------------------------------------------------
	// Local state (synced with v-model props)
	// ---------------------------------------------------------------------------
	const canvasBlocks = ref<EditorBlock[]>([]);
	const formName = ref('');
	const formSubject = ref('');
	const emailBackgroundColor = ref('#ffffff');

	// Sync props → local
	let lastEmittedBlocks: EditorBlock[] | null = null;

	watch(
		() => props.blocks,
		(v) => {
			if (v === lastEmittedBlocks) return; // Skip echo from our own emit
			const next = canvasBlocksOf(v);
			if (
				lastEmittedBlocks &&
				next.length === lastEmittedBlocks.length &&
				next.every((b, i) => b.id === lastEmittedBlocks![i]!.id)
			)
				return;
			canvasBlocks.value = next;
		},
		{ immediate: true }
	);

	watch(
		() => props.subject,
		(v) => {
			if (v !== formSubject.value) formSubject.value = v;
		},
		{ immediate: true }
	);
	watch(
		() => props.name,
		(v) => {
			if (v !== formName.value) formName.value = v;
		},
		{ immediate: true }
	);
	// Seed the background from an explicit page-supplied value, else the org theme's
	// configured background — otherwise the hardcoded white default masked the org
	// theme background in both the editor preview and the test-send.
	watch(
		() => props.backgroundColor ?? props.config?.theme?.backgroundColor,
		(v) => {
			if (v && v !== emailBackgroundColor.value) emailBackgroundColor.value = v;
		},
		{ immediate: true }
	);

	// One counter for every change to the block tree; everything below that
	// follows the canvas watches it instead of deep-watching the blocks.
	const { version: blocksVersion, bump: bumpBlocks } = useBlockTreeVersion(canvasBlocks);

	// Emit local → props
	watch(
		blocksVersion,
		() => {
			lastEmittedBlocks = canvasBlocks.value;
			emit('update:blocks', canvasBlocks.value);
		},
		{ flush: 'post' }
	);
	watch(formSubject, (v) => emit('update:subject', v));
	watch(formName, (v) => emit('update:name', v));
	watch(emailBackgroundColor, (v) => emit('update:backgroundColor', v));

	return { canvasBlocks, formName, formSubject, emailBackgroundColor, blocksVersion, bumpBlocks };
}
