<script lang="ts">
import type { Id } from '@owlat/api/dataModel';

/**
 * One thread-list row's message shape. Extracted here (shared with
 * PostboxThreadList.vue) so the list and the row agree on the projection the
 * folder query returns.
 */
export type PostboxThreadRowMessage = {
	_id: Id<'mailMessages'>;
	threadId?: string;
	fromAddress: string;
	fromName?: string;
	subject: string;
	snippet: string;
	receivedAt: number;
	flagSeen: boolean;
	flagFlagged: boolean;
	hasAttachments: boolean;
	snoozedUntil?: number;
	// Thread follow-up watch state (mail/followUps.ts): `watched` marks the
	// sent message the watch points at; `dueAt` means the deadline passed
	// with no reply ("No reply yet" chip).
	followUp?: { remindAt: number; dueAt?: number; watched: boolean };
};
</script>

<script setup lang="ts">
/**
 * A single Postbox thread-list row. The list owns the v-for, windowing and all
 * mutations; this component is a pure presentational row that maps DOM events to
 * semantic emits (its `<li>` is the v-for element root). Splitting the row out
 * keeps PostboxThreadList.vue under the file-size ratchet.
 */
import type { ContextMenuItem } from '@owlat/ui/components/ui/ContextMenu.vue';

const props = defineProps<{
	msg: PostboxThreadRowMessage;
	selectable?: boolean;
	folderRole: string;
	virtualize: boolean;
	selected: boolean;
	focused: boolean;
	active: boolean;
}>();

const emit = defineEmits<{
	select: [];
	'toggle-select': [];
	'toggle-star': [];
	'toggle-read': [];
	archive: [];
	trash: [];
	'cancel-follow-up': [];
}>();

const rowId = computed(() => `postbox-row-${props.msg._id}`);

/** Checkbox toggles selection without following the row's NuxtLink. */
function onCheckboxClick(event: MouseEvent) {
	event.stopPropagation();
	event.preventDefault();
	emit('toggle-select');
}

/**
 * Emit one of the row's triage verbs. Both the hover-action buttons and the
 * right-click context menu route through here, so there is ONE action source
 * (the list's mutation handlers) with two entry points.
 *
 * Narrow to a literal per branch: Vue types `emit` as an intersection of
 * per-event call signatures, so a union-typed argument matches no overload.
 */
function triage(e: 'toggle-star' | 'toggle-read' | 'archive' | 'trash') {
	switch (e) {
		case 'toggle-star':
			emit('toggle-star');
			break;
		case 'toggle-read':
			emit('toggle-read');
			break;
		case 'archive':
			emit('archive');
			break;
		case 'trash':
			emit('trash');
			break;
	}
}

/** Stop a hover-action button from following the row's NuxtLink, then triage. */
function rowAction(event: MouseEvent, e: 'toggle-star' | 'toggle-read' | 'archive' | 'trash') {
	event.stopPropagation();
	event.preventDefault();
	triage(e);
}

// Right-click / context-menu-key items — the same triage verbs as the hover
// row-actions (one action source, two entry points).
const contextItems = computed<ContextMenuItem[]>(() => [
	{
		id: 'star',
		label: props.msg.flagFlagged ? 'Unstar' : 'Star',
		icon: 'lucide:star',
		run: () => triage('toggle-star'),
	},
	{
		id: 'read',
		label: props.msg.flagSeen ? 'Mark as unread' : 'Mark as read',
		icon: props.msg.flagSeen ? 'lucide:mail' : 'lucide:mail-open',
		run: () => triage('toggle-read'),
	},
	{
		id: 'archive',
		label: 'Archive',
		icon: 'lucide:archive',
		run: () => triage('archive'),
	},
	{
		id: 'trash',
		label: 'Delete',
		icon: 'lucide:trash',
		danger: true,
		separatorBefore: true,
		run: () => triage('trash'),
	},
]);
</script>

<template>
	<UiContextMenu :items="contextItems">
		<template #default="{ onContextmenu, onKeydown }">
			<li
				class="group relative"
				:class="{ 'pbx-virtual-row': virtualize }"
				style="content-visibility: auto; contain-intrinsic-size: auto var(--pbx-row-intrinsic, 76px)"
				@contextmenu="onContextmenu"
				@keydown="onKeydown"
			>
		<component
			:is="selectable ? 'div' : (resolveComponent('NuxtLink') as 'div')"
			:id="rowId"
			role="option"
			:tabindex="selectable ? -1 : undefined"
			:aria-selected="focused"
			:to="selectable ? undefined : `/dashboard/postbox/${folderRole}/${msg._id}`"
			class="pbx-row-link block w-full text-left px-4 py-3 hover:bg-(--surface-1-hover)"
			:class="{
				'bg-(--surface-1-selected)': active,
				'bg-brand/5': selected,
				'ring-1 ring-inset ring-brand/50': focused,
				'cursor-pointer': selectable,
			}"
			@click="selectable ? emit('select') : undefined"
		>
			<div class="flex items-start gap-2">
				<button
					type="button"
					class="mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center"
					:class="
						selected
							? 'bg-brand border-brand text-white'
							: 'border-border-subtle bg-bg-base opacity-0 group-hover:opacity-100'
					"
					:aria-label="selected ? 'Deselect' : 'Select'"
					@click="onCheckboxClick($event)"
				>
					<Icon v-if="selected" name="lucide:check" class="w-3 h-3" />
				</button>
				<UiAvatar
					:name="msg.fromName"
					:email="msg.fromAddress"
					deterministic-color
					size="sm"
					class="flex-shrink-0"
					aria-hidden="true"
				/>
				<PostboxRowCore :unread="!msg.flagSeen">
					<template #identifier>{{ msg.fromName || msg.fromAddress }}</template>
					<template #meta>{{ formatThreadTimestamp(msg.receivedAt) }}</template>
					<div class="flex items-center gap-1.5 mt-0.5">
						<Icon v-if="msg.flagFlagged" name="lucide:star" class="w-3.5 h-3.5 text-warning" />
						<Icon
							v-if="msg.snoozedUntil"
							name="lucide:clock"
							class="w-3.5 h-3.5 text-brand"
							:title="`Snoozed until ${new Date(msg.snoozedUntil).toLocaleString()}`"
						/>
						<Icon
							v-if="msg.hasAttachments"
							name="lucide:paperclip"
							class="w-3.5 h-3.5 text-text-tertiary"
						/>
						<PostboxThreadRowFollowUp
							v-if="msg.followUp?.watched"
							:follow-up="msg.followUp"
							@cancel="
								(e: MouseEvent) => {
									e.stopPropagation();
									e.preventDefault();
									emit('cancel-follow-up');
								}
							"
						/>
						<p
							class="truncate text-sm flex-1"
							:class="msg.flagSeen ? 'text-text-secondary' : 'font-medium text-text-primary'"
						>
							{{ msg.subject || '(no subject)' }}
						</p>
					</div>
					<p class="pbx-row-snippet text-xs text-text-tertiary truncate mt-0.5">
						{{ msg.snippet }}
					</p>
				</PostboxRowCore>
			</div>
		</component>
		<!-- Hover quick-actions (single-message triage without a round-trip
		     through the bulk selection). -->
		<div
			class="ui-hover-reveal absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-0.5 bg-bg-elevated/95 rounded px-1 py-0.5 shadow-sm border border-border-subtle"
		>
			<button
				type="button"
				class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-warning"
				:title="msg.flagFlagged ? 'Unstar' : 'Star'"
				:aria-label="msg.flagFlagged ? 'Unstar' : 'Star'"
				@click="rowAction($event, 'toggle-star')"
			>
				<Icon name="lucide:star" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-text-primary"
				:title="msg.flagSeen ? 'Mark unread' : 'Mark read'"
				:aria-label="msg.flagSeen ? 'Mark unread' : 'Mark read'"
				@click="rowAction($event, 'toggle-read')"
			>
				<Icon :name="msg.flagSeen ? 'lucide:mail' : 'lucide:mail-open'" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="p-1 rounded hover:bg-bg-surface text-text-tertiary hover:text-text-primary"
				title="Archive"
				aria-label="Archive"
				@click="rowAction($event, 'archive')"
			>
				<Icon name="lucide:archive" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="p-1 rounded hover:bg-error/10 text-text-tertiary hover:text-error"
				title="Delete"
				aria-label="Delete"
				@click="rowAction($event, 'trash')"
			>
				<Icon name="lucide:trash" class="w-4 h-4" />
			</button>
				</div>
			</li>
		</template>
	</UiContextMenu>
</template>
