<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Team inbox members — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const route = useRoute();
const mailboxId = computed(() => route.params['mailboxId'] as Id<'mailboxes'>);

const { data: mailbox } = useConvexQuery(api.mail.mailbox.get, () => ({
	mailboxId: mailboxId.value,
}));
const {
	data: membersData,
	isLoading: membersLoading,
	error: membersError,
} = useConvexQuery(api.mail.mailboxMembers.members, () => ({ mailboxId: mailboxId.value }));
const { data: myRole } = useConvexQuery(api.mail.mailboxMembers.myRole, () => ({
	mailboxId: mailboxId.value,
}));

const members = computed(() => membersData.value ?? []);
const canManage = computed(() => myRole.value === 'owner');

// Org roster for the "add member" picker.
const { members: orgMembers, fetchMembers } = useOrganization();
onMounted(() => void fetchMembers());

const memberIds = computed(() => new Set(members.value.map((m) => m.authUserId)));
const addableMembers = computed(() =>
	orgMembers.value.filter((m) => !memberIds.value.has(m.userId))
);

const error = ref<string | null>(null);
const addMember = useBackendOperation(api.mail.mailboxMembers.addMember, {
	label: 'Add member',
	inlineTarget: error,
});
const removeMember = useBackendOperation(api.mail.mailboxMembers.removeMember, {
	label: 'Remove member',
	inlineTarget: error,
});
const transferOwnership = useBackendOperation(api.mail.mailboxMembers.transferOwnership, {
	label: 'Transfer ownership',
	inlineTarget: error,
});

const memberToAdd = ref('');

async function handleAdd() {
	if (!memberToAdd.value) return;
	const res = await addMember.run({ mailboxId: mailboxId.value, authUserId: memberToAdd.value });
	if (res === undefined) return;
	memberToAdd.value = '';
}

async function handleRemove(authUserId: string) {
	await removeMember.run({ mailboxId: mailboxId.value, authUserId });
}

async function handleTransfer(authUserId: string) {
	await transferOwnership.run({ mailboxId: mailboxId.value, authUserId });
}

const busy = computed(
	() =>
		addMember.isLoading.value || removeMember.isLoading.value || transferOwnership.isLoading.value
);
</script>

<template>
	<div class="p-6 lg:p-8 max-w-2xl mx-auto">
		<NuxtLink
			to="/dashboard/postbox/settings"
			class="text-sm text-text-secondary inline-flex items-center gap-1 hover:text-text-primary mb-4"
		>
			<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
			Back to settings
		</NuxtLink>

		<h1 class="text-2xl font-semibold">Team inbox members</h1>
		<p v-if="mailbox" class="text-text-secondary mt-1">
			Who can read and send from <code>{{ mailbox.address }}</code
			>.
		</p>

		<div v-if="error" class="mt-4 text-sm text-error">{{ error }}</div>

		<!-- Add a member (owners only) -->
		<section v-if="canManage" class="card mt-6 p-5">
			<h2 class="font-semibold mb-3">Add a member</h2>
			<div v-if="addableMembers.length === 0" class="text-sm text-text-secondary">
				Everyone in your organization is already a member.
			</div>
			<div v-else class="flex items-center gap-2">
				<select v-model="memberToAdd" class="input flex-1" :disabled="busy">
					<option value="">Select a teammate…</option>
					<option v-for="m in addableMembers" :key="m.userId" :value="m.userId">
						{{ m.user.name || m.user.email }} ({{ m.user.email }})
					</option>
				</select>
				<UiButton :loading="addMember.isLoading.value" :disabled="!memberToAdd" @click="handleAdd">
					Add
				</UiButton>
			</div>
		</section>

		<!-- Roster -->
		<section class="card mt-6 !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">Members</h2>
			</header>
			<div v-if="membersLoading && members.length === 0" class="p-8 flex justify-center">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>
			<div v-else-if="membersError" class="p-6 text-sm text-error">
				Couldn't load the member list. Please try again.
			</div>
			<div v-else-if="members.length === 0" class="p-8 text-center text-text-secondary">
				No members yet.
			</div>
			<ul v-else class="divide-y divide-border-subtle">
				<li
					v-for="m in members"
					:key="m._id"
					class="px-5 py-3 flex items-center justify-between gap-3"
				>
					<div class="min-w-0">
						<p class="font-medium truncate">
							{{ m.name || m.email || 'Member' }}
							<span v-if="m.isYou" class="text-xs text-text-tertiary">(you)</span>
						</p>
						<p v-if="m.email" class="text-xs text-text-tertiary truncate">{{ m.email }}</p>
					</div>
					<div class="flex items-center gap-2 shrink-0">
						<span
							class="text-xs px-2 py-0.5 rounded"
							:class="
								m.role === 'owner'
									? 'bg-brand-subtle text-brand'
									: 'bg-bg-surface text-text-tertiary'
							"
							>{{ m.role === 'owner' ? 'Owner' : 'Member' }}</span
						>
						<UiButton
							v-if="canManage && m.role !== 'owner'"
							variant="ghost"
							size="sm"
							:disabled="busy"
							title="Make this member the owner"
							@click="handleTransfer(m.authUserId)"
						>
							Make owner
						</UiButton>
						<button
							v-if="canManage && m.role !== 'owner'"
							type="button"
							class="p-1.5 rounded text-text-tertiary hover:text-error hover:bg-error/10"
							title="Remove member"
							aria-label="Remove member"
							:disabled="busy"
							@click="handleRemove(m.authUserId)"
						>
							<Icon name="lucide:user-minus" class="w-4 h-4" />
						</button>
					</div>
				</li>
			</ul>
		</section>

		<p v-if="!canManage" class="text-xs text-text-tertiary mt-3">
			Only inbox owners and organization admins can change who's a member.
		</p>
	</div>
</template>
