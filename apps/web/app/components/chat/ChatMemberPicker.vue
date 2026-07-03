<script setup lang="ts">
export interface ChatMemberCandidate {
	memberId: string;
	name: string | null;
	email: string | null;
}

export interface SelectedChatMember {
	memberId: string;
	label: string;
}

withDefaults(
	defineProps<{
		label?: string;
		labelHint?: string;
		placeholder?: string;
	}>(),
	{
		label: 'Members',
		labelHint: '',
		placeholder: 'Search by name or email…',
	},
);

// Selected members are owned here so add/remove + chip rendering live in one
// place. The search query is also v-modelled so the parent can drive its own
// candidate search (which differs between the channel and DM dialogs).
const selectedMembers = defineModel<SelectedChatMember[]>({ required: true });
const query = defineModel<string>('query', { required: true });

const selectedIds = computed(() => new Set(selectedMembers.value.map((m) => m.memberId)));

const addMember = (member: ChatMemberCandidate) => {
	const label = member.name ?? member.email ?? member.memberId;
	selectedMembers.value = [...selectedMembers.value, { memberId: member.memberId, label }];
	query.value = '';
};

const removeMember = (memberId: string) => {
	selectedMembers.value = selectedMembers.value.filter((m) => m.memberId !== memberId);
};
</script>

<template>
	<div>
		<label for="query" class="block text-sm font-medium text-text-secondary mb-1.5">
			{{ label }}
			<span v-if="labelHint" class="text-text-tertiary font-normal">{{ labelHint }}</span>
		</label>
		<input id="query" v-model="query" type="text" :placeholder="placeholder" class="input w-full" />

		<!-- Candidate dropdown markup differs per dialog, so it's supplied via slot. -->
		<slot name="candidates" :add-member="addMember" :selected-ids="selectedIds" :query="query" />

		<div v-if="selectedMembers.length > 0" class="flex flex-wrap gap-1 mt-2">
			<span
				v-for="member in selectedMembers"
				:key="member.memberId"
				class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-brand-subtle text-brand text-xs"
			>
				{{ member.label }}
				<button @click="removeMember(member.memberId)" :aria-label="`Remove ${member.label}`">
					<Icon name="lucide:x" class="w-3 h-3" />
				</button>
			</span>
		</div>
	</div>
</template>
