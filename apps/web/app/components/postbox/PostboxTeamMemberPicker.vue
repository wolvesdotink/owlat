<script setup lang="ts">
/**
 * The "who can use this team inbox" roster picker, shared by the hosted and the
 * external (BYO IMAP) team-inbox create flows in add-account.vue so both prepare
 * the initial roster identically. Presentational: the parent owns the org-member
 * list and the selected-id set; this only renders the checkboxes and emits a
 * toggle. The creator is always the owner and is excluded upstream.
 */
export interface PickerMember {
	userId: string;
	user: { name?: string | null; email: string };
}

defineProps<{
	members: PickerMember[];
	selectedIds: string[];
	loading?: boolean;
}>();

const emit = defineEmits<{ (e: 'toggle', userId: string): void }>();
</script>

<template>
	<div>
		<label class="text-sm font-medium block mb-1">Members</label>
		<p class="text-xs text-text-tertiary mb-2">
			Choose who can read and send from this inbox. You can change this later.
		</p>
		<div
			v-if="loading && members.length === 0"
			class="flex items-center gap-2 text-text-secondary text-sm py-2"
		>
			<Icon name="lucide:loader-2" class="w-4 h-4 animate-spin" />
			Loading teammates…
		</div>
		<p v-else-if="members.length === 0" class="text-sm text-text-secondary">
			No teammates to add yet — you can invite people and add them later.
		</p>
		<ul v-else class="space-y-1 max-h-56 overflow-y-auto">
			<li v-for="m in members" :key="m.userId">
				<label class="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-surface cursor-pointer">
					<input
						type="checkbox"
						:checked="selectedIds.includes(m.userId)"
						@change="emit('toggle', m.userId)"
					/>
					<span class="min-w-0">
						<span class="text-sm block truncate">{{ m.user.name || m.user.email }}</span>
						<span class="text-xs text-text-tertiary block truncate">{{ m.user.email }}</span>
					</span>
				</label>
			</li>
		</ul>
	</div>
</template>
