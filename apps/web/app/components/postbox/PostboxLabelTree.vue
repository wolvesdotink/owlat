<script setup lang="ts">
/**
 * The folder rail's label tree.
 *
 * Labels used to render as a flat, unordered, uncounted wall — thirty rows in
 * alphabetical order with no signal which had new mail. This is the same list
 * with the three things folders always had: nesting, a manual order, and unread
 * counts. A collapsed branch shows its rolled-up count, so folding `Work` away
 * never hides the fact that something under it is unread.
 *
 * Reordering is drag-first with a keyboard-reachable equivalent: the ▲/▼
 * buttons on a focused row write exactly the same sibling order the drop does,
 * so the feature is not mouse-only.
 */

import type { Id } from '@owlat/api/dataModel';
import { flattenLabelTree, labelAncestorIds } from '~/utils/postboxLabelTree';
import { moveSibling } from '~/utils/postboxReorder';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	/** The label whose view is open, so its branch can be revealed. */
	activeLabelId?: string;
}>();

const { t } = useI18n();

const mailboxIdRef = computed(() => props.mailboxId);
const { labels, labelTree, reorder, setParent } = usePostboxLabels(mailboxIdRef);
const { collapsedIds, toggle, expandAll } = usePostboxLabelCollapse();

// Navigating to a label inside a folded branch must not leave the rail showing
// no selection at all.
watch(
	() => props.activeLabelId,
	(id) => {
		if (id) expandAll(labelAncestorIds(labels.value, id));
	},
	{ immediate: true }
);

const rows = computed(() => flattenLabelTree(labelTree.value, collapsedIds.value));

/** The sibling run a label belongs to, in rendered order — what reorder writes. */
function siblingIds(labelId: string): Id<'mailLabels'>[] {
	const parentId = labels.value.find((l) => l._id === labelId)?.parentId;
	const findRun = (nodes: typeof labelTree.value): Id<'mailLabels'>[] | null => {
		for (const node of nodes) {
			if (node.label.parentId === parentId && node.label._id === labelId) {
				return nodes.map((n) => n.label._id as Id<'mailLabels'>);
			}
			const hit = findRun(node.children);
			if (hit) return hit;
		}
		return null;
	};
	return findRun(labelTree.value) ?? [];
}

async function move(labelId: string, delta: -1 | 1) {
	const ids = siblingIds(labelId);
	const next = moveSibling(ids, labelId, delta);
	// `moveSibling` returns the input unchanged at either end, so an edge press
	// costs no round trip.
	if (next.every((id, i) => id === ids[i])) return;
	await reorder(next as Id<'mailLabels'>[]);
}

const draggingId = ref<string | null>(null);
const dropTargetId = ref<string | null>(null);

function onDragStart(labelId: string) {
	draggingId.value = labelId;
}

function onDragOver(labelId: string) {
	if (draggingId.value && draggingId.value !== labelId) dropTargetId.value = labelId;
}

async function onDrop(targetId: string) {
	const sourceId = draggingId.value;
	draggingId.value = null;
	dropTargetId.value = null;
	if (!sourceId || sourceId === targetId) return;

	const source = labels.value.find((l) => l._id === sourceId);
	const target = labels.value.find((l) => l._id === targetId);
	if (!source || !target) return;

	// Dropping across branches is a REPARENT to the target's parent followed by
	// a position write, so one gesture cannot leave the label somewhere the user
	// did not aim for. Same-parent drops skip straight to the position write.
	if (source.parentId !== target.parentId) {
		await setParent(
			sourceId as Id<'mailLabels'>,
			(target.parentId ?? null) as Id<'mailLabels'> | null
		);
	}
	const run = siblingIds(targetId).filter((id) => id !== sourceId);
	const at = run.indexOf(targetId as Id<'mailLabels'>);
	run.splice(at === -1 ? run.length : at, 0, sourceId as Id<'mailLabels'>);
	await reorder(run);
}
</script>

<template>
	<ul class="flex flex-col gap-0.5">
		<li
			v-for="row in rows"
			:key="row.label._id"
			class="group flex items-center"
			:class="{ 'opacity-50': draggingId === row.label._id }"
			draggable="true"
			@dragstart="onDragStart(row.label._id)"
			@dragover.prevent="onDragOver(row.label._id)"
			@dragleave="dropTargetId = null"
			@drop.prevent="onDrop(row.label._id)"
			@dragend="
				draggingId = null;
				dropTargetId = null;
			"
		>
			<!-- Indent by depth; the twisty occupies the same slot on a leaf so
			     names stay aligned down a branch. -->
			<span :style="{ width: `${row.depth * 0.75}rem` }" class="flex-shrink-0" />
			<button
				v-if="row.children.length > 0"
				type="button"
				class="w-4 h-4 flex items-center justify-center text-text-tertiary hover:text-text-primary flex-shrink-0"
				:aria-expanded="!collapsedIds.has(row.label._id)"
				:aria-label="
					collapsedIds.has(row.label._id)
						? t('components.postbox.postboxLabelTree.expand', { name: row.label.name })
						: t('components.postbox.postboxLabelTree.collapse', { name: row.label.name })
				"
				@click="toggle(row.label._id)"
			>
				<Icon
					:name="collapsedIds.has(row.label._id) ? 'lucide:chevron-right' : 'lucide:chevron-down'"
					class="w-3 h-3"
				/>
			</button>
			<span v-else class="w-4 flex-shrink-0" />

			<NuxtLink
				:to="`/dashboard/postbox/label/${row.label._id}`"
				class="flex-1 flex items-center gap-2 px-1.5 py-1 rounded text-sm hover:bg-bg-surface min-w-0"
				:class="{
					'bg-bg-surface text-brand': activeLabelId === row.label._id,
					'ring-1 ring-brand': dropTargetId === row.label._id,
				}"
			>
				<span
					class="w-2.5 h-2.5 rounded-full flex-shrink-0"
					:style="{ backgroundColor: row.label.color || '#6b7280' }"
				/>
				<Icon
					v-if="row.label.isPinned"
					name="lucide:pin"
					class="w-3 h-3 flex-shrink-0 text-text-tertiary"
				/>
				<span class="truncate flex-1">{{ row.label.name }}</span>
				<!-- Collapsed rows carry the branch total, so folding a branch never
				     hides unread mail; expanded rows show only their own. -->
				<span
					v-if="(collapsedIds.has(row.label._id) ? row.totalUnreadCount : row.unreadCount) > 0"
					class="text-xs font-medium text-text-secondary flex-shrink-0"
				>
					{{ collapsedIds.has(row.label._id) ? row.totalUnreadCount : row.unreadCount }}
				</span>
			</NuxtLink>

			<!-- Keyboard-reachable equivalent of the drag: same write, one step. -->
			<button
				type="button"
				class="opacity-0 group-hover:opacity-100 focus:opacity-100 p-0.5 text-text-tertiary hover:text-text-primary"
				:aria-label="t('components.postbox.postboxLabelTree.moveUp', { name: row.label.name })"
				@click="move(row.label._id, -1)"
			>
				<Icon name="lucide:chevron-up" class="w-3 h-3" />
			</button>
			<button
				type="button"
				class="opacity-0 group-hover:opacity-100 focus:opacity-100 p-0.5 text-text-tertiary hover:text-text-primary"
				:aria-label="t('components.postbox.postboxLabelTree.moveDown', { name: row.label.name })"
				@click="move(row.label._id, 1)"
			>
				<Icon name="lucide:chevron-down" class="w-3 h-3" />
			</button>
		</li>
		<li v-if="rows.length === 0" class="text-xs text-text-tertiary px-2 py-1">
			{{ t('components.postbox.postboxFolderRail.noLabels') }}
		</li>
	</ul>
</template>
