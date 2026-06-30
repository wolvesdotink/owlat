<script setup lang="ts">
import { computed, ref, shallowRef, watch, onMounted, onUnmounted, type Component, type Ref } from 'vue';
import type { EditorBlock, BlockType, Variable, EmailTheme } from '../../types';
import { getSchema } from '../../schema';
import type { BlockAttributeSchema, PropertyGroup as PropertyGroupType } from '../../schema/types';
import { getToolbarFields } from '../../schema/toolbar';
import { useToolbarPosition } from '../../composables/useToolbarPosition';
import { getByPath } from '../../utils/propertyPath';
import PropertyGroup from '../panel/PropertyGroup.vue';
import NestedItemsEditor from '../panel/NestedItemsEditor.vue';
import ToolbarField from './ToolbarField.vue';
import IconButton from '../ui/IconButton.vue';
import ToolbarDivider from '../ui/ToolbarDivider.vue';
import {
	Bold, Italic, Underline, Link,
	AlignLeft, AlignCenter, AlignRight,
	FileText, Palette, Move, SlidersHorizontal,
	Copy, Trash2, Link2, Unlink, Bookmark,
} from '@lucide/vue';

// ---------------------------------------------------------------------------
// Tab categorisation (ported from BlockSettingsPopover)
// ---------------------------------------------------------------------------

interface TabDef {
	id: string;
	label: string;
	icon: Component;
	match: string[];
}

const TAB_DEFS: TabDef[] = [
	{
		id: 'content',
		label: 'Content',
		icon: FileText,
		match: ['Content', 'Data', 'Items', 'Sections', 'Links', 'Images', 'Labels', 'Behavior'],
	},
	{
		id: 'design',
		label: 'Design',
		icon: Palette,
		match: ['Typography', 'Style', 'Layout', 'Background', 'Retina', 'Button Border'],
	},
	{
		id: 'spacing',
		label: 'Spacing',
		icon: Move,
		match: ['Spacing', 'Border'],
	},
	{
		id: 'more',
		label: 'More',
		icon: SlidersHorizontal,
		match: ['Dark Mode', 'Responsive', 'Advanced', 'Dark', 'Mobile'],
	},
];

function categoriseGroup(group: PropertyGroupType): string {
	for (const tab of TAB_DEFS) {
		if (tab.match.includes(group.label)) return tab.id;
	}
	return 'content';
}

// ---------------------------------------------------------------------------
// Props / Emits
// ---------------------------------------------------------------------------

const props = defineProps<{
	block: EditorBlock;
	anchorElement: HTMLElement;
	schema: BlockAttributeSchema;
	isInlineEditing: boolean;
	variables?: Variable[];
	theme: Required<EmailTheme>;
	onUploadImage?: (file: File) => Promise<{ url: string; storageId?: string }>;
	isLinked?: boolean;
	linkedBlockName?: string | null;
	/** Whether the host wired a savedBlocks.save handler (shows "Save as block"). */
	canSaveAsBlock?: boolean;
}>();

const emit = defineEmits<{
	(e: 'update', blockId: string, key: string, value: unknown): void;
	(e: 'format', command: string, value?: string): void;
	(e: 'delete'): void;
	(e: 'duplicate'): void;
	(e: 'detach'): void;
	(e: 'save-block'): void;
	(e: 'select-child', blockId: string, childId: string): void;
	(e: 'add-child', blockId: string, childType: BlockType): void;
	(e: 'remove-child', blockId: string, childId: string): void;
	(e: 'reorder-children', blockId: string, children: unknown[]): void;
}>();

// ---------------------------------------------------------------------------
// Toolbar positioning
// ---------------------------------------------------------------------------

const toolbarEl = shallowRef<HTMLElement | null>(null);
const subPopoverEl = shallowRef<HTMLElement | null>(null);
const anchorRef = computed(() => props.anchorElement) as unknown as Ref<HTMLElement | null>;

const { positionStyles } = useToolbarPosition({
	anchorElement: anchorRef,
	toolbarElement: toolbarEl,
});

// ---------------------------------------------------------------------------
// Schema-driven state
// ---------------------------------------------------------------------------

const schema = computed<BlockAttributeSchema | undefined>(() => getSchema(props.block.type));

const isContainerType = computed(() =>
	['columns', 'container', 'hero', 'accordion'].includes(props.block.type),
);

const toolbarFields = computed(() => getToolbarFields(props.schema));

/** Map of tabId → groups for the current block schema */
const groupsByTab = computed(() => {
	const map = new Map<string, PropertyGroupType[]>();
	if (!schema.value) return map;
	for (const group of schema.value.groups) {
		const tabId = categoriseGroup(group);
		if (!map.has(tabId)) map.set(tabId, []);
		map.get(tabId)!.push(group);
	}
	return map;
});

/** Only show categories that have groups for this block */
const visibleCategories = computed(() => {
	return TAB_DEFS.filter((tab) => {
		if (tab.id === 'content' && isContainerType.value) return true;
		return groupsByTab.value.has(tab.id);
	});
});

/** Groups for the active category */
const activeGroups = computed(() => {
	return groupsByTab.value.get(activeCategory.value ?? '') ?? [];
});

// ---------------------------------------------------------------------------
// Sub-popover state
// ---------------------------------------------------------------------------

const activeCategory = ref<string | null>(null);

function toggleCategory(catId: string) {
	activeCategory.value = activeCategory.value === catId ? null : catId;
}

// Close sub-popover on block change or inline edit toggle
watch(() => props.block.id, () => {
	activeCategory.value = null;
});

watch(() => props.isInlineEditing, () => {
	activeCategory.value = null;
});

// ---------------------------------------------------------------------------
// Sub-popover positioning (centered below toolbar)
// ---------------------------------------------------------------------------

const subPopoverStyles = computed(() => {
	if (!toolbarEl.value || !activeCategory.value) return { display: 'none' };
	const toolbarRect = toolbarEl.value.getBoundingClientRect();
	const popoverWidth = 300;
	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;

	// Center below toolbar
	let left = toolbarRect.left + (toolbarRect.width - popoverWidth) / 2;
	const top = toolbarRect.bottom + 6;

	// Clamp horizontally
	left = Math.max(8, Math.min(left, viewportWidth - popoverWidth - 8));

	const maxHeight = Math.min(viewportHeight - top - 16, 420);

	return {
		position: 'fixed' as const,
		top: `${Math.round(top)}px`,
		left: `${Math.round(left)}px`,
		width: `${popoverWidth}px`,
		maxHeight: `${maxHeight}px`,
		zIndex: 1001,
	};
});

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

function getFieldValue(key: string): unknown {
	return getByPath(props.block.content, key);
}

function handleFieldUpdate(key: string, value: unknown) {
	emit('update', props.block.id, key, value);
}

// ---------------------------------------------------------------------------
// Click outside (closes sub-popover only, not the toolbar)
// ---------------------------------------------------------------------------

function handleClickOutside(event: MouseEvent) {
	if (!subPopoverEl.value || !activeCategory.value) return;
	const target = event.target as Node;
	if (subPopoverEl.value.contains(target)) return;
	if (toolbarEl.value?.contains(target)) return;
	// Ignore clicks inside modals (e.g. media picker) that are teleported to body
	if (target instanceof HTMLElement && target.closest('[role="dialog"]')) return;
	activeCategory.value = null;
}

onMounted(() => {
	document.addEventListener('mousedown', handleClickOutside);
});

onUnmounted(() => {
	document.removeEventListener('mousedown', handleClickOutside);
});
</script>

<template>
	<Teleport to="body">
		<!-- Main toolbar bar -->
		<div
			ref="toolbarEl"
			role="toolbar"
			aria-label="Block formatting"
			class="light fixed z-[1000] flex items-center gap-0.5 py-[5px] px-2 bg-bg-elevated/95 backdrop-blur-sm border border-border-subtle rounded-[10px] shadow-[0_4px_16px_rgba(0,0,0,0.12)] pointer-events-auto animate-eb-toolbar-enter"
			:style="positionStyles"
			@mousedown.stop
		>
			<!-- ===== Inline editing mode: formatting controls ===== -->
			<template v-if="isInlineEditing && block.type === 'text'">
				<IconButton :icon="Bold" title="Bold" aria-label="Bold" @click="emit('format', 'bold')" />
				<IconButton :icon="Italic" title="Italic" aria-label="Italic" @click="emit('format', 'italic')" />
				<IconButton :icon="Underline" title="Underline" aria-label="Underline" @click="emit('format', 'underline')" />
				<IconButton :icon="Link" title="Link" aria-label="Link" @click="emit('format', 'createLink')" />
				<ToolbarDivider />
				<IconButton :icon="AlignLeft" title="Align left" aria-label="Align left" @click="emit('update', block.id, 'textAlign', 'left')" />
				<IconButton :icon="AlignCenter" title="Align center" aria-label="Align center" @click="emit('update', block.id, 'textAlign', 'center')" />
				<IconButton :icon="AlignRight" title="Align right" aria-label="Align right" @click="emit('update', block.id, 'textAlign', 'right')" />
			</template>

			<!-- ===== Linked block mode ===== -->
			<template v-else-if="isLinked">
				<div class="flex items-center gap-1.5 px-1.5">
					<Link2 :size="12" class="text-brand/60 shrink-0" />
					<span class="text-[11px] font-medium text-text-secondary whitespace-nowrap max-w-[140px] overflow-hidden text-ellipsis">
						{{ linkedBlockName || 'Linked block' }}
					</span>
				</div>
				<ToolbarDivider />
				<IconButton :icon="Unlink" title="Detach" aria-label="Detach" @click="emit('detach')" />
				<IconButton :icon="Trash2" title="Delete" aria-label="Delete" size="sm" variant="destructive" @click="emit('delete')" />
			</template>

			<!-- ===== Normal mode: category icons + quick fields + actions ===== -->
			<template v-else>
				<!-- Category icons -->
				<template v-if="visibleCategories.length > 0">
					<IconButton
						v-for="cat in visibleCategories"
						:key="cat.id"
						:icon="cat.icon"
						:title="cat.label"
						:aria-label="cat.label"
						:active="activeCategory === cat.id"
						@click="toggleCategory(cat.id)"
					/>
					<ToolbarDivider v-if="toolbarFields.length > 0" />
				</template>

				<!-- Quick-access toolbar fields -->
				<ToolbarField
					v-for="field in toolbarFields"
					:key="field.key"
					:field="field"
					:value="getFieldValue(field.key)"
					@update="handleFieldUpdate"
				/>

				<ToolbarDivider v-if="toolbarFields.length > 0 || visibleCategories.length > 0" />

				<!-- Save as reusable block, Duplicate & Delete -->
				<IconButton
					v-if="canSaveAsBlock"
					:icon="Bookmark"
					title="Save as reusable block"
					aria-label="Save as reusable block"
					size="sm"
					@click="emit('save-block')"
				/>
				<IconButton :icon="Copy" title="Duplicate" aria-label="Duplicate" size="sm" @click="emit('duplicate')" />
				<IconButton :icon="Trash2" title="Delete" aria-label="Delete" size="sm" variant="destructive" @click="emit('delete')" />
			</template>
		</div>

		<!-- ===== Sub-popover (drops below toolbar) ===== -->
		<div
			v-if="activeCategory && !isLinked && !isInlineEditing"
			ref="subPopoverEl"
			class="light bg-bg-elevated rounded-xl border border-border-subtle shadow-[0_8px_32px_rgba(0,0,0,0.12)] overflow-hidden flex flex-col animate-eb-fade-in"
			:style="subPopoverStyles"
			@mousedown.stop
		>
			<!-- Scrollable content -->
			<div class="overflow-y-auto overflow-x-hidden flex-1 min-h-0">
				<PropertyGroup
					v-for="group in activeGroups"
					:key="group.label"
					:group="{ ...group, collapsed: false }"
					:block="block"
					:theme="theme"
					:variables="variables"
					:on-upload-image="onUploadImage"
					:hide-header="activeGroups.length === 1"
					@update="handleFieldUpdate"
				/>

				<!-- Nested items (container types) — only in content category -->
				<NestedItemsEditor
					v-if="isContainerType && activeCategory === 'content'"
					:block="block"
					:theme="theme"
					@select-child="(childId) => emit('select-child', block.id, childId)"
					@add-child="(childType) => emit('add-child', block.id, childType)"
					@remove-child="(childId) => emit('remove-child', block.id, childId)"
					@reorder-children="(children) => emit('reorder-children', block.id, children)"
				/>
			</div>
		</div>
	</Teleport>
</template>
