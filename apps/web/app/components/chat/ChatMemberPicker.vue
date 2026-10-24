<script setup lang="ts">
/**
 * Picks teammates for a new channel or DM: a search box over the matching
 * members (`UiCombobox`), and the picked ones as removable chips.
 *
 * The caller searches and decides who can be added (the DM dialog also leaves
 * out the person writing); this component shows those `candidates` while a
 * query is typed. ↑ ↓ move, Enter adds the highlighted member (the top match
 * by default) and clears the query; the list stays open for the next one.
 */
import { useId } from 'vue';

export interface ChatMemberCandidate {
	memberId: string;
	name: string | null;
	email: string | null;
	image?: string | null;
}

export interface SelectedChatMember {
	memberId: string;
	label: string;
}

const props = withDefaults(
	defineProps<{
		/** Members that can be added for the current query (the caller's search). */
		candidates?: ChatMemberCandidate[];
		label?: string;
		labelHint?: string;
		placeholder?: string;
		/** Show each candidate's avatar. */
		avatars?: boolean;
	}>(),
	{
		candidates: () => [],
		label: undefined,
		labelHint: '',
		placeholder: undefined,
		avatars: false,
	}
);

const { t } = useI18n();

// Defaults live here rather than in `withDefaults` because prop defaults are
// evaluated outside of setup, where `t` is not available.
const labelText = computed(() => props.label ?? t('components.chat.chatMemberPicker.label'));
const placeholderText = computed(
	() => props.placeholder ?? t('components.chat.chatMemberPicker.placeholder')
);

// Selected members are owned here so add/remove + chip rendering live in one
// place. The search query is also v-modelled so the parent can drive its own
// candidate search (which differs between the channel and DM dialogs).
const selectedMembers = defineModel<SelectedChatMember[]>({ required: true });
const query = defineModel<string>('query', { required: true });

const inputId = `chat-member-query-${useId()}`;

/** Nothing is offered before something is typed. */
const shown = computed(() => (query.value ? props.candidates : []));

const nameOf = (member: ChatMemberCandidate) => member.name ?? member.email ?? member.memberId;

const addMember = (member: ChatMemberCandidate) => {
	if (selectedMembers.value.some((m) => m.memberId === member.memberId)) return;
	selectedMembers.value = [
		...selectedMembers.value,
		{ memberId: member.memberId, label: nameOf(member) },
	];
	query.value = '';
};

const removeMember = (memberId: string) => {
	selectedMembers.value = selectedMembers.value.filter((m) => m.memberId !== memberId);
};
</script>

<template>
	<div>
		<label :for="inputId" class="block text-sm font-medium text-text-secondary mb-1.5">
			{{ labelText }}
			<span v-if="labelHint" class="text-text-tertiary font-normal">{{ labelHint }}</span>
		</label>
		<UiCombobox
			v-model:query="query"
			:input-id="inputId"
			:options="shown"
			:option-key="(member: ChatMemberCandidate) => member.memberId"
			:label="t('components.chat.chatMemberPicker.listLabel')"
			:placeholder="placeholderText"
			auto-highlight
			stay-open
			list-class="max-h-48 overflow-y-auto p-1"
			option-class="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-text-primary data-highlighted:bg-bg-surface"
			@select="addMember"
		>
			<template #option="{ option }">
				<UiAvatar
					v-if="avatars"
					:name="option.name"
					:email="option.email"
					:image="option.image ?? null"
					size="sm"
					bg="elevated"
				/>
				<span>{{ nameOf(option) }}</span>
			</template>
		</UiCombobox>

		<div v-if="selectedMembers.length > 0" class="flex flex-wrap gap-1 mt-2">
			<span
				v-for="member in selectedMembers"
				:key="member.memberId"
				class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-brand-subtle text-brand text-xs"
			>
				{{ member.label }}
				<button
					@click="removeMember(member.memberId)"
					:aria-label="t('components.chat.chatMemberPicker.removeMember', { name: member.label })"
				>
					<Icon name="lucide:x" class="w-3 h-3" />
				</button>
			</span>
		</div>
	</div>
</template>
