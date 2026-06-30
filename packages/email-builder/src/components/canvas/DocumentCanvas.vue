<script setup lang="ts">
import { computed, ref, watch, nextTick, inject, onMounted, onUnmounted } from 'vue';
import type { EditorBlock, EmailTheme, Variable, SlashCommand, BlockType } from '../../types';
import type { ParentContext } from './types';
import DocumentBlock from './DocumentBlock.vue';
import DragHandle from './DragHandle.vue';
import BlockPlaceholder from './BlockPlaceholder.vue';
import BlockInsertPoint from './BlockInsertPoint.vue';
import InlineTextEditor from './InlineTextEditor.vue';
import ColorField from '../panel/fields/ColorField.vue';
import { useDraggable } from 'vue-draggable-plus';
import { Link } from '@lucide/vue';

const props = defineProps<{
	blocks: EditorBlock[];
	selectedBlockId: string | null;
	selectedNestedItemId?: string | null;
	theme: Required<EmailTheme>;
	backgroundColor?: string;
	inlineEditBlockId?: string | null;
	variables?: Variable[];
	/** Restrict the insertable palette to this allowlist (EmailBuilderConfig.blockTypes). Undefined = all. */
	blockTypes?: BlockType[];
}>();

const emit = defineEmits<{
	(e: 'update:blocks', blocks: EditorBlock[]): void;
	(e: 'select', blockId: string): void;
	(e: 'select-nested', payload: { itemId: string; context: ParentContext; element: HTMLElement }): void;
	(e: 'clear-selection'): void;
	(e: 'update-children', blockId: string, children: unknown[]): void;
	(e: 'double-click-block', blockId: string): void;
	(e: 'exit-inline-edit'): void;
	(e: 'slash-command-select', command: SlashCommand, blockId: string): void;
	(e: 'add-text-block'): void;
	(e: 'insert-block-after', blockId: string): void;
	(e: 'insert-block-at', type: BlockType, afterBlockId: string): void;
	(e: 'open-link-dialog', blockId: string): void;
	(e: 'paste-image', file: File): void;
	(e: 'paste-rich-content', html: string): void;
	(e: 'update:backgroundColor', value: string): void;
}>();

// Background color popover
const showBgColorPopover = ref(false);
const bgColorBubbleRef = ref<HTMLElement | null>(null);
const bgColorPopoverRef = ref<HTMLElement | null>(null);

function toggleBgColorPopover(event: MouseEvent) {
	event.stopPropagation();
	showBgColorPopover.value = !showBgColorPopover.value;
}

function handleBgClickOutside(event: MouseEvent) {
	if (!showBgColorPopover.value) return;
	const target = event.target as Node;
	if (bgColorBubbleRef.value?.contains(target) || bgColorPopoverRef.value?.contains(target)) return;
	showBgColorPopover.value = false;
}

onMounted(() => document.addEventListener('mousedown', handleBgClickOutside));
onUnmounted(() => document.removeEventListener('mousedown', handleBgClickOutside));

// Dragging state for hiding insert points
const isDragging = ref(false);

// Expose the inner element for sidebar positioning
const canvasInnerRef = ref<HTMLElement | null>(null);
defineExpose({ canvasInnerElement: canvasInnerRef });

// Linked block state (provided by EmailBuilder)
const isLinkedBlockFn = inject<(id: string) => boolean>('isLinkedBlock', () => false);
const isFirstInLinkedGroup = inject<(id: string) => boolean>('isFirstInLinkedGroup', () => false);
const isLastInLinkedGroup = inject<(id: string) => boolean>('isLastInLinkedGroup', () => false);
const requestDetachLinkedBlock = inject<(id: string) => void>('requestDetachLinkedBlock', () => {});
const setBlockElement = inject<(blockId: string, el: HTMLElement | null) => void>('setBlockElement', () => {});

// Register inline editor ref with parent EmailBuilder
const registerInlineEditor = inject<(ref: { el: HTMLElement } | null) => void>('registerInlineEditor', () => {});

// Group consecutive linked blocks into single draggable units
interface DisplayItem {
	id: string;
	blocks: EditorBlock[];
}

const displayItems = computed<DisplayItem[]>(() => {
	const items: DisplayItem[] = [];
	const seen = new Set<string>();

	for (const block of props.blocks) {
		if (block.savedBlockRef) {
			const groupId = block.savedBlockRef.groupId;
			if (seen.has(groupId)) continue;
			seen.add(groupId);
			const groupBlocks = props.blocks.filter(
				(b) => b.savedBlockRef?.groupId === groupId,
			);
			items.push({ id: `group-${groupId}`, blocks: groupBlocks });
		} else {
			items.push({ id: block.id, blocks: [block] });
		}
	}
	return items;
});

// Direct ref for Sortable.js — no VueDraggable component overhead
const containerRef = ref<HTMLElement | null>(null);
const dragList = ref<DisplayItem[]>([]);

// Sync parent → dragList with guard to prevent re-emission
let isExternalSync = false;
watch(displayItems, (newItems) => {
	isExternalSync = true;
	dragList.value = [...newItems];
	nextTick(() => { isExternalSync = false; });
}, { immediate: true });

// Initialize Sortable.js directly via composable
useDraggable(containerRef, dragList, {
	group: { name: 'canvas', put: true },
	handle: '.drag-handle',
	animation: 200,
	ghostClass: 'document-canvas__ghost',
	onStart: () => { isDragging.value = true; },
	onEnd: () => {
		syncDragListToParent();
		nextTick(() => { isDragging.value = false; });
	},
	onAdd: () => {
		syncDragListToParent();
	},
});

function syncDragListToParent() {
	if (isExternalSync) return;
	const normalized: DisplayItem[] = dragList.value.map((item: DisplayItem | EditorBlock) => {
		if ('blocks' in item && Array.isArray(item.blocks)) return item as DisplayItem;
		if ('type' in item && 'content' in item) {
			return { id: item.id, blocks: [item] };
		}
		return item as DisplayItem;
	});
	const newBlocks = normalized.flatMap((item) => item.blocks);
	if (newBlocks.length === props.blocks.length && newBlocks.every((b, i) => b.id === props.blocks[i]!.id)) {
		return;
	}
	emit('update:blocks', newBlocks);
}

function handleCanvasClick(event: MouseEvent) {
	const target = event.target as HTMLElement;
	if (target.classList.contains('document-canvas__bg') || target.classList.contains('document-canvas__inner')) {
		emit('clear-selection');
	}
}

function handlePaste(event: ClipboardEvent) {
	// Don't intercept paste inside contenteditable (inline text editors)
	const target = event.target as HTMLElement;
	if (target.isContentEditable || target.closest('[contenteditable="true"]')) return;

	const data = event.clipboardData;
	if (!data) return;

	// 1. Image paste (existing behavior)
	const items = data.items;
	if (items) {
		for (let i = 0; i < items.length; i++) {
			const item = items[i]!;
			if (item.type.startsWith('image/')) {
				event.preventDefault();
				const file = item.getAsFile();
				if (file) emit('paste-image', file);
				return;
			}
		}
	}

	// 2. Rich HTML paste
	const html = data.getData('text/html');
	if (html) {
		event.preventDefault();
		emit('paste-rich-content', html);
		return;
	}

	// 3. Plain text fallback
	const text = data.getData('text/plain');
	if (text?.trim()) {
		event.preventDefault();
		const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		const wrapped = escaped.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
		emit('paste-rich-content', wrapped);
	}
}

function handleBlockSelect(blockId: string, event: MouseEvent) {
	event.stopPropagation();
	emit('select', blockId);
}

function handleBlockDoubleClick(blockId: string, blockType: string) {
	if (blockType === 'text') {
		emit('double-click-block', blockId);
	}
}

// Ref callback to register block elements
function setBlockRef(blockId: string, el: HTMLElement | null) {
	setBlockElement(blockId, el);
}

// Track inline editor refs from InlineTextEditor
type InlineEditorComponentRef = {
	el?: HTMLElement | { value?: HTMLElement | null } | null;
} | null;

const inlineEditorComps = ref<Map<string, InlineEditorComponentRef>>(new Map());
function handleInlineEditorMounted(blockId: string, comp: InlineEditorComponentRef) {
	inlineEditorComps.value.set(blockId, comp);
	const el = comp?.el;
	const htmlEl = el && ('value' in el ? el.value : el) as HTMLElement | null;
	if (htmlEl) {
		registerInlineEditor({ el: htmlEl });
	}
}
</script>

<template>
	<div
		class="document-canvas__bg flex-1 overflow-y-auto flex justify-center p-6 scrollbar-thin-overlay bg-bg-base"
		@click="handleCanvasClick"
		@paste="handlePaste"
	>
		<div ref="canvasInnerRef" class="document-canvas__inner max-w-full min-h-[200px]" :style="{ width: (props.theme.baseWidth ?? 600) + 60 + 'px' }">
			<div
				class="relative rounded-lg shadow-[0_1px_4px_rgba(0,0,0,0.08)] px-10 py-6"
				:style="{ backgroundColor: backgroundColor || '#ffffff' }"
			>
				<!-- Background color bubble on the top-right border -->
				<button
					ref="bgColorBubbleRef"
					type="button"
					class="absolute -top-3 right-4 z-10 flex items-center gap-1.5 h-6 pl-1 pr-2 rounded-full bg-bg-elevated border border-border-subtle shadow-sm cursor-pointer transition-shadow hover:shadow-md"
					title="Email background color"
					@click="toggleBgColorPopover"
				>
					<span
						class="w-4 h-4 rounded-full border border-border-default shrink-0"
						:style="{ backgroundColor: backgroundColor || '#ffffff' }"
					/>
					<span class="text-[11px] font-medium text-text-secondary leading-none">Background</span>
				</button>

				<Teleport to="body">
					<div
						v-if="showBgColorPopover"
						ref="bgColorPopoverRef"
						class="light fixed z-[9999] bg-bg-elevated border border-border-subtle rounded-xl shadow-lg p-3 w-[240px]"
						:style="{
							top: (bgColorBubbleRef?.getBoundingClientRect().bottom ?? 0) + 6 + 'px',
							left: (bgColorBubbleRef?.getBoundingClientRect().right ?? 0) - 240 + 'px',
						}"
					>
						<div class="text-[11px] font-medium text-text-secondary uppercase tracking-wide mb-2">Email Background</div>
						<ColorField
							:value="backgroundColor || '#ffffff'"
							@update="emit('update:backgroundColor', $event)"
						/>
					</div>
				</Teleport>
				<slot name="subject-fields" />

				<div ref="containerRef" class="min-h-[100px]">
					<div v-for="item in displayItems" :key="item.id">
						<div
							v-for="block in item.blocks"
							:key="block.id"
							:ref="(el) => setBlockRef(block.id, el as HTMLElement)"
							:class="[
								'relative group/block transition-all duration-150 rounded-md',
								isLinkedBlockFn(block.id)
									? [
										'border-x-2 border-y-0 border-dashed border-border-default my-0 rounded-none',
										isFirstInLinkedGroup(block.id) && 'border-t-2 rounded-t-md mt-2',
										isLastInLinkedGroup(block.id) && 'border-b-2 rounded-b-md mb-1',
										isFirstInLinkedGroup(block.id) && isLastInLinkedGroup(block.id) && '!rounded-md',
										selectedBlockId === block.id && '!border-brand',
										selectedBlockId !== block.id && 'hover:border-border-strong',
									]
									: [
										'border-2 my-0.5',
										selectedBlockId === block.id || inlineEditBlockId === block.id
											? 'border-brand shadow-[0_0_0_1px_rgba(196,120,90,0.15)]'
											: 'border-transparent hover:border-border-subtle',
									],
							]"
							:data-block-id="block.id"
							@click="(e) => handleBlockSelect(block.id, e)"
							@dblclick="() => handleBlockDoubleClick(block.id, block.type)"
						>
							<!-- Drag handle -->
							<DragHandle
								v-if="!isLinkedBlockFn(block.id) || isFirstInLinkedGroup(block.id)"
								:visible="selectedBlockId === block.id"
							/>

							<!-- Block type label -->
							<div
								v-if="selectedBlockId === block.id && inlineEditBlockId !== block.id"
								class="absolute -top-2.5 left-2 text-[10px] font-semibold py-0.5 px-2 rounded bg-brand text-white uppercase z-[5] shadow-sm animate-eb-slide-up"
							>
								{{ block.type }}
							</div>

							<!-- Linked group header -->
							<div
								v-if="isLinkedBlockFn(block.id) && isFirstInLinkedGroup(block.id)"
								class="absolute -top-[9px] left-3 z-[6] inline-flex items-center gap-1 bg-bg-elevated px-1.5"
							>
								<span class="text-[10px] font-semibold text-text-tertiary uppercase whitespace-nowrap tracking-[0.02em]">
									{{ block.savedBlockRef?.blockName || 'Linked block' }}
								</span>
								<button
									class="inline-flex items-center justify-center w-[18px] h-[18px] p-0 text-text-tertiary bg-transparent border-none rounded-[3px] cursor-pointer transition-colors duration-150 hover:text-brand hover:bg-brand/10"
									title="Detach"
									type="button"
									@click.stop="requestDetachLinkedBlock(block.id)"
								>
									<Link :size="12" />
								</button>
							</div>

							<!-- Block content: inline text editor or preview -->
							<div v-if="inlineEditBlockId === block.id && block.type === 'text'" class="relative">
								<InlineTextEditor
									:ref="(comp) => comp && handleInlineEditorMounted(block.id, comp as unknown as InlineEditorComponentRef)"
									:block="block"
									:theme="theme"
									:variables="variables"
									@exit="emit('exit-inline-edit')"
									@slash-command-select="(cmd: SlashCommand) => emit('slash-command-select', cmd, block.id)"
									@insert-block-after="emit('insert-block-after', block.id)"
									@open-link-dialog="emit('open-link-dialog', block.id)"
								/>
							</div>
							<div v-else>
								<DocumentBlock
									:block="block"
									:theme="theme"
									:selected-nested-item-id="selectedNestedItemId"
									:inline-edit-block-id="inlineEditBlockId"
									:variables="variables"
									@select-nested="(payload) => emit('select-nested', payload)"
									@update-children="(blockId, children) => emit('update-children', blockId, children)"
									@double-click-block="(id) => emit('double-click-block', id)"
									@exit-inline-edit="emit('exit-inline-edit')"
									@slash-command-select="(cmd: SlashCommand, blockId: string) => emit('slash-command-select', cmd, blockId)"
									@insert-block-after="(id: string) => emit('insert-block-after', id)"
									@open-link-dialog="(id: string) => emit('open-link-dialog', id)"
								/>
							</div>
						</div>
						<!-- Insert point after each block -->
						<BlockInsertPoint
							:after-block-id="item.blocks[item.blocks.length - 1]!.id"
							:is-dragging="isDragging"
							:block-types="blockTypes"
							@insert-block="(type, afterId) => emit('insert-block-at', type, afterId)"
						/>
					</div>
				</div>

				<!-- Block placeholder at bottom -->
				<BlockPlaceholder
					v-if="blocks.length > 0"
					@click="emit('add-text-block')"
				/>

				<!-- Empty state -->
				<div
					v-if="blocks.length === 0"
					class="flex flex-col items-center justify-center gap-2 h-60 border-2 border-dashed border-border-subtle rounded-lg my-4 cursor-pointer transition-[border-color,background-color] duration-150 hover:border-brand hover:bg-brand/[0.02]"
					@click="emit('add-text-block')"
				>
					<svg class="text-text-tertiary" width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
						<rect x="6" y="6" width="36" height="36" rx="4" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3" />
						<line x1="24" y1="16" x2="24" y2="32" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
						<line x1="16" y1="24" x2="32" y2="24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
					</svg>
					<p class="text-sm font-medium text-text-secondary m-0">Start building your email</p>
					<p class="text-[13px] text-text-tertiary m-0">Click to start typing or use the toolbar above</p>
				</div>
			</div>

			<!-- Slot for content below the email canvas (e.g. attachments) -->
			<slot name="after-canvas" />
		</div>
	</div>
</template>

<style>
.document-canvas__ghost {
	opacity: 0.4;
	transform: scale(0.98);
}
</style>
