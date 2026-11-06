<script setup lang="ts">
import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import type { OrganizationMember } from '~/composables/useOrganization';
import { groupMembersFromRoster, memberDiff } from '~/utils/memberGroups';
import {
	ChevronDownIcon,
	CloseSmallIcon,
	PencilIcon,
	MoreHorizontalIcon,
	PlusIcon,
	ReloadIcon,
	TrashIcon,
	UsersGroupIcon,
} from '@coolicons/vue';

/**
 * The Groups section of the Team page. A member group is who a task shown to
 * that group reaches, so every member may see the groups and their members;
 * only owners and admins (`canManage`) create, edit and delete them. The
 * server enforces the same split (apps/api/convex/tasks/groups.ts).
 */
const props = defineProps<{
	/** The workspace roster the page already holds, for names and avatars. */
	members: OrganizationMember[];
	canManage: boolean;
}>();

type MemberGroup = FunctionReturnType<typeof api.tasks.groups.list>[number];

const { t } = useI18n();
const { showToast } = useToast();

const {
	data: groups,
	error: groupsError,
	refetch,
} = useConvexQuery(api.tasks.groups.list, () => ({}));

const list = computed<MemberGroup[]>(() => groups.value ?? []);
const isLoading = computed(() => groups.value === undefined && !groupsError.value);

/** Avatars a card shows before it folds the rest into "+N". */
const AVATAR_LIMIT = 5;

function rosterOf(group: MemberGroup) {
	return groupMembersFromRoster(group.memberUserIds, props.members);
}

function memberLabel(member: OrganizationMember) {
	return member.user.name || member.user.email;
}

// Which groups have their member list unfolded.
const expanded = ref<Set<string>>(new Set());
function toggleExpanded(groupId: string) {
	const next = new Set(expanded.value);
	if (next.has(groupId)) next.delete(groupId);
	else next.add(groupId);
	expanded.value = next;
}

const menuOpen = reactive<Record<string, boolean>>({});

// ── Create / edit ───────────────────────────────────────────────────────────

const dialogOpen = ref(false);
const editing = ref<MemberGroup | null>(null);
const dialogError = ref<string | null>(null);
const saving = ref(false);

const createOp = useBackendOperation(api.tasks.groups.create, {
	label: () => t('dashboard.admin.team.groups.operations.create'),
	inlineTarget: dialogError,
});
const renameOp = useBackendOperation(api.tasks.groups.rename, {
	label: () => t('dashboard.admin.team.groups.operations.rename'),
	inlineTarget: dialogError,
});
const addMemberOp = useBackendOperation(api.tasks.groups.addMember, {
	label: () => t('dashboard.admin.team.groups.operations.addMember'),
});
const removeMemberOp = useBackendOperation(api.tasks.groups.removeMember, {
	label: () => t('dashboard.admin.team.groups.operations.removeMember'),
});

function openCreate() {
	editing.value = null;
	dialogError.value = null;
	dialogOpen.value = true;
}

function openEdit(group: MemberGroup) {
	editing.value = group;
	dialogError.value = null;
	dialogOpen.value = true;
}

function closeDialog() {
	if (saving.value) return;
	dialogOpen.value = false;
}

/**
 * Save the dialog. A new group is one write; an edit is a rename (when the name
 * changed) and one write per member who joins or leaves, in that order, and
 * stops at the first refusal with the dialog still open.
 */
async function save(value: { name: string; memberUserIds: string[] }) {
	saving.value = true;
	try {
		const group = editing.value;
		if (!group) {
			const created = await createOp.run({ name: value.name, memberUserIds: value.memberUserIds });
			if (!created.ok) return;
			showToast(t('dashboard.admin.team.groups.toasts.created', { name: value.name }));
			dialogOpen.value = false;
			return;
		}
		if (value.name !== group.name) {
			const renamed = await renameOp.run({ groupId: group._id, name: value.name });
			if (!renamed.ok) return;
		}
		const { added, removed } = memberDiff(group.memberUserIds, value.memberUserIds);
		for (const userId of added) {
			if (!(await addMemberOp.run({ groupId: group._id, userId })).ok) return;
		}
		for (const userId of removed) {
			if (!(await removeMemberOp.run({ groupId: group._id, userId })).ok) return;
		}
		showToast(t('dashboard.admin.team.groups.toasts.saved', { name: value.name }));
		dialogOpen.value = false;
	} finally {
		saving.value = false;
	}
}

// ── Remove one member straight from the card ────────────────────────────────

const removingKey = ref<string | null>(null);

async function removeFromGroup(group: MemberGroup, member: OrganizationMember) {
	removingKey.value = `${group._id}:${member.userId}`;
	try {
		const result = await removeMemberOp.run({ groupId: group._id, userId: member.userId });
		if (!result.ok) return;
		showToast(
			t('dashboard.admin.team.groups.toasts.memberRemoved', {
				member: memberLabel(member),
				name: group.name,
			})
		);
	} finally {
		removingKey.value = null;
	}
}

// ── Delete ──────────────────────────────────────────────────────────────────

const toDelete = ref<MemberGroup | null>(null);
const deleteError = ref<string | null>(null);

// The server refuses to delete a group that still has tasks (`invalid_state`),
// because those tasks would lose their audience. That refusal is a normal
// answer, so it is shown in the dialog instead of a toast, in the viewer's
// language: the server's own sentence is English only.
const removeOp = useBackendOperation(api.tasks.groups.remove, {
	label: () => t('dashboard.admin.team.groups.operations.remove'),
	onError: (error) => {
		if (error.category !== 'invalid_state') return false;
		deleteError.value = t('dashboard.admin.team.groups.deleteDialog.hasTasks');
		return true;
	},
});

function askDelete(group: MemberGroup) {
	deleteError.value = null;
	toDelete.value = group;
}

async function confirmDelete() {
	const group = toDelete.value;
	if (!group) return;
	deleteError.value = null;
	const result = await removeOp.run({ groupId: group._id });
	if (!result.ok) return;
	showToast(t('dashboard.admin.team.groups.toasts.deleted', { name: group.name }));
	toDelete.value = null;
}
</script>

<template>
	<UiCard padding="none" data-testid="member-groups">
		<template #header>
			<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
				<div class="flex items-center gap-3">
					<UiIconBox :icon="UsersGroupIcon" size="sm" variant="surface" rounded="lg" />
					<div>
						<h2 class="text-lg font-semibold text-text-primary">
							{{ t('dashboard.admin.team.groups.title') }}
						</h2>
						<p class="text-sm text-text-secondary">
							{{ t('dashboard.admin.team.groups.lede') }}
						</p>
					</div>
				</div>
				<UiButton
					v-if="canManage && list.length > 0"
					size="sm"
					variant="secondary"
					class="whitespace-nowrap"
					data-testid="member-groups-new"
					@click="openCreate"
				>
					<template #iconLeft>
						<PlusIcon class="w-4 h-4" />
					</template>
					{{ t('dashboard.admin.team.groups.newGroup') }}
				</UiButton>
			</div>
		</template>

		<!-- Loading -->
		<div v-if="isLoading" class="divide-y divide-border-subtle" aria-busy="true">
			<span class="sr-only">{{ t('dashboard.admin.team.groups.loading') }}</span>
			<UiSkeletonRow v-for="n in 2" :key="n" class="px-6 py-4" :lines="2" trailing />
		</div>

		<!-- Error with nothing to show -->
		<div
			v-else-if="groupsError && list.length === 0"
			class="flex items-center justify-between gap-3 px-6 py-4"
			role="alert"
		>
			<p class="text-sm text-text-secondary">{{ t('dashboard.admin.team.groups.loadError') }}</p>
			<UiButton variant="ghost" size="sm" @click="refetch()">
				<template #iconLeft>
					<ReloadIcon class="w-4 h-4" />
				</template>
				{{ t('common.retry') }}
			</UiButton>
		</div>

		<!-- Empty -->
		<UiEmptyState
			v-else-if="list.length === 0"
			:icon="UsersGroupIcon"
			:title="t('dashboard.admin.team.groups.empty.title')"
			:description="
				canManage
					? t('dashboard.admin.team.groups.empty.description')
					: t('dashboard.admin.team.groups.empty.descriptionReadOnly')
			"
			data-testid="member-groups-empty"
		>
			<template v-if="canManage" #action>
				<UiButton size="sm" data-testid="member-groups-create-first" @click="openCreate">
					<template #iconLeft>
						<PlusIcon class="w-4 h-4" />
					</template>
					{{ t('dashboard.admin.team.groups.empty.action') }}
				</UiButton>
			</template>
		</UiEmptyState>

		<!-- Groups -->
		<ul v-else class="divide-y divide-border-subtle">
			<li v-for="group in list" :key="group._id" class="px-6 py-3" data-testid="member-group-row">
				<div class="flex items-center gap-3">
					<!-- The name is the disclosure for the member list, so the
					     keyboard reaches who is in the group the same way a click does. -->
					<button
						type="button"
						class="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						:aria-expanded="expanded.has(group._id)"
						:aria-controls="`member-group-${group._id}`"
						data-testid="member-group-toggle"
						@click="toggleExpanded(group._id)"
					>
						<ChevronDownIcon
							class="w-4 h-4 shrink-0 text-text-tertiary transition-transform"
							:class="{ '-rotate-90': !expanded.has(group._id) }"
						/>
						<span class="truncate font-medium text-text-primary">{{ group.name }}</span>
						<UiBadge v-if="group.isMember" size="sm" variant="neutral" pill class="shrink-0">
							{{ t('dashboard.admin.team.groups.youAreIn') }}
						</UiBadge>
					</button>

					<!-- Avatar stack + count -->
					<div class="flex shrink-0 items-center gap-2">
						<div class="hidden sm:flex -space-x-1.5" aria-hidden="true">
							<UiAvatar
								v-for="member in rosterOf(group).members.slice(0, AVATAR_LIMIT)"
								:key="member.userId"
								:name="member.user.name"
								:email="member.user.email"
								:image="member.user.image"
								size="sm"
								class="ring-2 ring-bg-elevated"
								:title="memberLabel(member)"
							/>
							<span
								v-if="rosterOf(group).members.length > AVATAR_LIMIT"
								class="flex h-6 min-w-6 items-center justify-center rounded-full border border-border-subtle bg-bg-surface px-1 text-[10px] font-medium text-text-secondary ring-2 ring-bg-elevated"
							>
								+{{ rosterOf(group).members.length - AVATAR_LIMIT }}
							</span>
						</div>
						<span class="text-sm text-text-secondary whitespace-nowrap">
							{{
								t(
									'dashboard.admin.team.groups.memberCount',
									{ count: group.memberUserIds.length },
									group.memberUserIds.length
								)
							}}
						</span>
					</div>

					<UiDropdownMenu v-if="canManage" v-model:open="menuOpen[group._id]">
						<template #trigger>
							<UiButton
								variant="ghost"
								size="sm"
								:aria-label="t('dashboard.admin.team.groups.rowActions', { name: group.name })"
								data-testid="member-group-menu"
							>
								<MoreHorizontalIcon class="w-4 h-4" />
							</UiButton>
						</template>
						<UiDropdownMenuItem :icon="PencilIcon" @click="openEdit(group)">
							{{ t('dashboard.admin.team.groups.edit') }}
						</UiDropdownMenuItem>
						<UiDropdownDivider />
						<UiDropdownMenuItem :icon="TrashIcon" danger @click="askDelete(group)">
							{{ t('dashboard.admin.team.groups.delete') }}
						</UiDropdownMenuItem>
					</UiDropdownMenu>
				</div>

				<!-- Member list -->
				<div
					v-if="expanded.has(group._id)"
					:id="`member-group-${group._id}`"
					class="mt-3 ml-6"
					data-testid="member-group-members"
				>
					<div
						v-if="group.memberUserIds.length === 0"
						class="flex flex-wrap items-center gap-3 text-sm text-text-tertiary"
					>
						<span>{{ t('dashboard.admin.team.groups.noMembers') }}</span>
						<UiButton v-if="canManage" variant="ghost" size="sm" @click="openEdit(group)">
							{{ t('dashboard.admin.team.groups.addMembers') }}
						</UiButton>
					</div>
					<ul v-else class="space-y-1">
						<li
							v-for="member in rosterOf(group).members"
							:key="member.userId"
							class="flex items-center gap-3 rounded-md py-1"
						>
							<UiAvatar
								:name="member.user.name"
								:email="member.user.email"
								:image="member.user.image"
								size="md"
							/>
							<span class="min-w-0 flex-1">
								<span class="block truncate text-sm text-text-primary">
									{{ memberLabel(member) }}
								</span>
								<span v-if="member.user.name" class="block truncate text-xs text-text-tertiary">
									{{ member.user.email }}
								</span>
							</span>
							<UiButton
								v-if="canManage"
								variant="ghost"
								size="sm"
								:loading="removingKey === `${group._id}:${member.userId}`"
								:aria-label="
									t('dashboard.admin.team.groups.removeMember', {
										member: memberLabel(member),
										name: group.name,
									})
								"
								data-testid="member-group-remove-member"
								@click="removeFromGroup(group, member)"
							>
								<CloseSmallIcon class="w-4 h-4" />
							</UiButton>
						</li>
						<li v-if="rosterOf(group).unknown > 0" class="py-1 text-xs text-text-tertiary">
							{{
								t(
									'dashboard.admin.team.groups.formerMembers',
									{ count: rosterOf(group).unknown },
									rosterOf(group).unknown
								)
							}}
						</li>
					</ul>
				</div>
			</li>
		</ul>

		<TeamMemberGroupDialog
			v-if="canManage"
			:open="dialogOpen"
			:group="editing"
			:groups="list"
			:members="members"
			:busy="saving"
			:error="dialogError"
			@close="closeDialog"
			@save="save"
		/>

		<UiConfirmationDialog
			v-if="canManage"
			:open="!!toDelete"
			variant="danger"
			:title="t('dashboard.admin.team.groups.deleteDialog.title', { name: toDelete?.name ?? '' })"
			:description="t('dashboard.admin.team.groups.deleteDialog.description')"
			:confirm-text="t('dashboard.admin.team.groups.deleteDialog.confirm')"
			:is-loading="removeOp.isLoading.value"
			@update:open="(v: boolean) => !v && (toDelete = null)"
			@confirm="confirmDelete"
		>
			<p
				v-if="deleteError"
				class="mt-4 text-sm text-error"
				role="alert"
				data-testid="member-group-delete-error"
			>
				{{ deleteError }}
			</p>
		</UiConfirmationDialog>
	</UiCard>
</template>
