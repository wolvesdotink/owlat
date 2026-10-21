<script setup lang="ts">
import {
	computed,
	ref,
	shallowRef,
	watch,
	onMounted,
	onUnmounted,
	type Component,
	type Ref,
} from 'vue';
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
	Bold,
	Italic,
	Underline,
	Link,
	AlignLeft,
	AlignCenter,
	AlignRight,
	FileText,
	Palette,
	Move,
	SlidersHorizontal,
	Copy,
	Trash2,
	Link2,
	Unlink,
	Bookmark,
} from '@lucide/vue';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

// ---------------------------------------------------------------------------
// Tab categorisation (ported from BlockSettingsPopover)
// ---------------------------------------------------------------------------

interface TabDef {
	/** Also the `builder.toolbar.categories.<id>` label key. */
	id: string;
	icon: Component;
	match: string[];
}

const TAB_DEFS: TabDef[] = [
	{
		id: 'content',
		icon: FileText,
		match: ['Content', 'Data', 'Items', 'Sections', 'Links', 'Images', 'Labels', 'Behavior'],
	},
	{
		id: 'design',
		icon: Palette,
		match: ['Typography', 'Style', 'Layout', 'Background', 'Retina', 'Button Border'],
	},
	{
		id: 'spacing',
		icon: Move,
		match: ['Spacing', 'Border'],
	},
	{
		id: 'more',
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
	['columns', 'container', 'hero', 'accordion'].includes(props.block.type)
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

/** Accessible name of the settings popover, so it is not an anonymous group. */
function categoryLabel(id: string): string {
	return t(`builder.toolbar.categories.${id}`);
}

const activeCategoryLabel = computed(() => {
	const tab = visibleCategories.value.find((candidate) => candidate.id === activeCategory.value);
	return tab
		? t('builder.toolbar.categorySettings', { category: categoryLabel(tab.id) })
		: t('builder.toolbar.settings');
});

// ---------------------------------------------------------------------------
// Sub-popover state
// ---------------------------------------------------------------------------

const activeCategory = ref<string | null>(null);

function toggleCategory(catId: string) {
	activeCategory.value = activeCategory.value === catId ? null : catId;
}

// Close sub-popover on block change or inline edit toggle
watch(
	() => props.block.id,
	() => {
		activeCategory.value = null;
	}
);

watch(
	() => props.isInlineEditing,
	() => {
		activeCategory.value = null;
	}
);

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
		// Same layer as the bar (and later in the DOM): under any dialog the
		// popover's fields open, e.g. the media picker.
		zIndex: 'var(--z-float)',
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
			:aria-label="t('builder.toolbar.formatting')"
			class="light fixed z-(--z-float) flex items-center gap-0.5 py-[5px] px-2 bg-bg-elevated/95 backdrop-blur-sm border border-border-subtle rounded-[10px] shadow-[0_4px_16px_rgba(0,0,0,0.12)] pointer-events-auto animate-eb-toolbar-enter"
			:style="positionStyles"
			@mousedown.stop
		>
			<!-- ===== Inline editing mode: formatting controls ===== -->
			<template v-if="isInlineEditing && block.type === 'text'">
				<IconButton
					:icon="Bold"
					:title="t('builder.toolbar.bold')"
					:aria-label="t('builder.toolbar.bold')"
					@click="emit('format', 'bold')"
				/>
				<IconButton
					:icon="Italic"
					:title="t('builder.toolbar.italic')"
					:aria-label="t('builder.toolbar.italic')"
					@click="emit('format', 'italic')"
				/>
				<IconButton
					:icon="Underline"
					:title="t('builder.toolbar.underline')"
					:aria-label="t('builder.toolbar.underline')"
					@click="emit('format', 'underline')"
				/>
				<IconButton
					:icon="Link"
					:title="t('builder.toolbar.link')"
					:aria-label="t('builder.toolbar.link')"
					@click="emit('format', 'createLink')"
				/>
				<ToolbarDivider />
				<IconButton
					:icon="AlignLeft"
					:title="t('builder.toolbar.alignLeft')"
					:aria-label="t('builder.toolbar.alignLeft')"
					@click="emit('update', block.id, 'textAlign', 'left')"
				/>
				<IconButton
					:icon="AlignCenter"
					:title="t('builder.toolbar.alignCenter')"
					:aria-label="t('builder.toolbar.alignCenter')"
					@click="emit('update', block.id, 'textAlign', 'center')"
				/>
				<IconButton
					:icon="AlignRight"
					:title="t('builder.toolbar.alignRight')"
					:aria-label="t('builder.toolbar.alignRight')"
					@click="emit('update', block.id, 'textAlign', 'right')"
				/>
			</template>

			<!-- ===== Linked block mode ===== -->
			<template v-else-if="isLinked">
				<div class="flex items-center gap-1.5 px-1.5">
					<Link2 :size="12" class="text-brand/60 shrink-0" />
					<span
						class="text-[11px] font-medium text-text-secondary whitespace-nowrap max-w-[140px] overflow-hidden text-ellipsis"
					>
						{{ linkedBlockName || t('builder.toolbar.linkedBlock') }}
					</span>
				</div>
				<ToolbarDivider />
				<IconButton
					:icon="Unlink"
					:title="t('builder.toolbar.detach')"
					:aria-label="t('builder.toolbar.detach')"
					@click="emit('detach')"
				/>
				<IconButton
					:icon="Trash2"
					:title="t('builder.toolbar.delete')"
					:aria-label="t('builder.toolbar.delete')"
					size="sm"
					variant="destructive"
					@click="emit('delete')"
				/>
			</template>

			<!-- ===== Normal mode: category icons + quick fields + actions ===== -->
			<template v-else>
				<!-- Category icons -->
				<template v-if="visibleCategories.length > 0">
					<IconButton
						v-for="cat in visibleCategories"
						:key="cat.id"
						:icon="cat.icon"
						:title="categoryLabel(cat.id)"
						:aria-label="categoryLabel(cat.id)"
						:active="activeCategory === cat.id"
						aria-haspopup="true"
						:aria-expanded="activeCategory === cat.id"
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
					:title="t('builder.toolbar.saveAsBlock')"
					:aria-label="t('builder.toolbar.saveAsBlock')"
					size="sm"
					@click="emit('save-block')"
				/>
				<IconButton
					:icon="Copy"
					:title="t('builder.toolbar.duplicate')"
					:aria-label="t('builder.toolbar.duplicate')"
					size="sm"
					@click="emit('duplicate')"
				/>
				<IconButton
					:icon="Trash2"
					:title="t('builder.toolbar.delete')"
					:aria-label="t('builder.toolbar.delete')"
					size="sm"
					variant="destructive"
					@click="emit('delete')"
				/>
			</template>
		</div>

		<!-- ===== Sub-popover (drops below toolbar) ===== -->
		<div
			v-if="activeCategory && !isLinked && !isInlineEditing"
			ref="subPopoverEl"
			role="group"
			:aria-label="activeCategoryLabel"
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
