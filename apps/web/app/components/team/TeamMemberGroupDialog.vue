<script setup lang="ts">
import type { OrganizationMember } from '~/composables/useOrganization';
import {
	GROUP_NAME_MAX_LENGTH,
	groupNameProblem,
	normalizeGroupName,
	type GroupNameProblem,
} from '~/utils/memberGroups';

/**
 * Create a member group, or edit one: its name and who is in it. Presentational:
 * the section owns the writes, their inflight flag and any refusal, and this
 * dialog stays open on a failed save so nothing typed is lost. Open while
 * `open` is true; `group` null means a new group.
 */
const props = defineProps<{
	open: boolean;
	group: { _id: string; name: string; memberUserIds: string[] } | null;
	/** Every group, so a name another group already has is caught before saving. */
	groups: readonly { _id: string; name: string }[];
	members: OrganizationMember[];
	busy: boolean;
	/** A refusal the server gave for the last save, shown under the form. */
	error: string | null;
}>();

const emit = defineEmits<{
	close: [];
	save: [value: { name: string; memberUserIds: string[] }];
}>();

const { t } = useI18n();

const name = ref('');
const selected = ref<string[]>([]);
// The name's problem shows once someone has tried to save, not while the
// field is still empty on open.
const attempted = ref(false);

watch(
	() => props.open,
	(open) => {
		if (!open) return;
		name.value = props.group?.name ?? '';
		selected.value = [...(props.group?.memberUserIds ?? [])];
		attempted.value = false;
	},
	{ immediate: true }
);

const problem = computed<GroupNameProblem | null>(() =>
	groupNameProblem(name.value, props.groups, props.group?._id)
);

const PROBLEM_KEYS: Record<GroupNameProblem, string> = {
	empty: 'dashboard.admin.team.groups.dialog.nameEmpty',
	tooLong: 'dashboard.admin.team.groups.dialog.nameTooLong',
	taken: 'dashboard.admin.team.groups.dialog.nameTaken',
};

const nameError = computed(() => {
	if (!problem.value) return undefined;
	if (!attempted.value && problem.value === 'empty') return undefined;
	return t(PROBLEM_KEYS[problem.value], {
		max: GROUP_NAME_MAX_LENGTH,
		name: normalizeGroupName(name.value),
	});
});

function submit() {
	attempted.value = true;
	if (problem.value || props.busy) return;
	emit('save', { name: normalizeGroupName(name.value), memberUserIds: [...selected.value] });
}

const nameId = useId();
</script>

<template>
	<UiModal
		:open="open"
		:title="
			group
				? t('dashboard.admin.team.groups.dialog.editTitle')
				: t('dashboard.admin.team.groups.dialog.createTitle')
		"
		size="lg"
		:persistent="busy"
		:closable="!busy"
		@update:open="(v: boolean) => !v && emit('close')"
	>
		<form class="space-y-5" data-testid="member-group-form" @submit.prevent="submit">
			<UiInput
				:id="nameId"
				v-model="name"
				:label="t('common.name')"
				:placeholder="t('dashboard.admin.team.groups.dialog.namePlaceholder')"
				:error="nameError"
				:disabled="busy"
				autocomplete="off"
				autofocus
			/>

			<div class="space-y-2">
				<p class="text-sm font-medium text-text-primary">
					{{ t('dashboard.admin.team.groups.dialog.membersLabel') }}
				</p>
				<p class="text-xs text-text-tertiary">
					{{ t('dashboard.admin.team.groups.dialog.membersHelp') }}
				</p>
				<TeamMemberPicker v-model="selected" :members="members" :disabled="busy" />
			</div>

			<p v-if="error" class="text-sm text-error" role="alert" data-testid="member-group-error">
				{{ error }}
			</p>
		</form>

		<template #footer>
			<UiButton variant="secondary" :disabled="busy" @click="emit('close')">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton :loading="busy" data-testid="member-group-save" @click="submit">
				{{
					group
						? t('dashboard.admin.team.groups.dialog.save')
						: t('dashboard.admin.team.groups.dialog.create')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
