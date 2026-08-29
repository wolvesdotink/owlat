<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

/**
 * Full member management for one team inbox: add an org member, invite someone
 * new by email, and the roster with remove / transfer-ownership actions.
 *
 * Extracted from `pages/dashboard/preferences/members/[mailboxId].vue` so
 * the admin Settings → Team inboxes page can embed the exact same management
 * surface inline per inbox. Management affordances follow `myRole` — the
 * backend grants org owners/admins effective `owner` on every team inbox, so
 * both consumers get the right controls from the same reactive query.
 */
const { t } = useI18n();

const props = defineProps<{ mailboxId: Id<'mailboxes'> }>();

const {
	data: membersData,
	isLoading: membersLoading,
	error: membersError,
} = useConvexQuery(api.mail.mailboxMembers.members, () => ({ mailboxId: props.mailboxId }));
const { data: myRole } = useConvexQuery(api.mail.mailboxMembers.myRole, () => ({
	mailboxId: props.mailboxId,
}));

const members = computed(() => membersData.value ?? []);
const canManage = computed(() => myRole.value === 'owner');

// Org roster for the "add member" picker.
const { members: orgMembers, fetchMembers, invite, canManageMembers } = useOrganization();
onMounted(() => void fetchMembers());

const memberIds = computed(() => new Set(members.value.map((m) => m.authUserId)));
const addableMembers = computed(() =>
	orgMembers.value.filter((m) => !memberIds.value.has(m.userId))
);

const error = ref<string | null>(null);
const addMember = useBackendOperation(api.mail.mailboxMembers.addMember, {
	label: () => t('components.postbox.teamInboxMembersPanel.addMemberOperation'),
	inlineTarget: error,
});
const removeMember = useBackendOperation(api.mail.mailboxMembers.removeMember, {
	label: () => t('components.postbox.teamInboxMembersPanel.removeMember'),
	inlineTarget: error,
});
const transferOwnership = useBackendOperation(api.mail.mailboxMembers.transferOwnership, {
	label: () => t('components.postbox.teamInboxMembersPanel.transferOwnershipOperation'),
	inlineTarget: error,
});
const reserveInboxMembership = useBackendOperation(
	api.mail.pendingInboxMembership.reserveInboxMembership,
	{
		label: () => t('components.postbox.teamInboxMembersPanel.inviteOperation'),
		inlineTarget: error,
	}
);
// Rollback for a reserve-succeeded-but-invite-failed partial: without this the
// grant would be orphaned (no invitation attached) yet still materialize on a
// later join.
const cancelInboxMembership = useBackendOperation(
	api.mail.pendingInboxMembership.cancelInboxMembershipsForEmail,
	{ label: () => t('components.postbox.teamInboxMembersPanel.undoReservationOperation') }
);

const memberToAdd = ref('');

// Invite-someone-new-by-email flow: reserve the team-inbox membership, then
// send the org invite. Reserving first lets the invitation email name the inbox
// and guarantees the membership is waiting when they accept.
const inviteEmail = ref('');
const inviteNotice = ref('');
const inviting = ref(false);

async function handleInvite() {
	const email = inviteEmail.value.trim();
	if (!email) return;
	error.value = null;
	inviteNotice.value = '';
	inviting.value = true;
	try {
		const reserved = await reserveInboxMembership.run({
			mailboxId: props.mailboxId,
			inviteeEmail: email,
		});
		// `run` already surfaced the failure inline; stop before issuing the invite.
		if (!reserved.ok) return;
		try {
			await invite(email, 'editor');
		} catch (inviteErr) {
			// Roll back only the grant THIS attempt created, and only this inbox's.
			// Skip when the grant already existed (`alreadyReserved`) — it belongs to
			// a prior, still-live invitation, so deleting it would strand that invite's
			// promised inbox. And scope the sweep to this mailbox so a duplicate-invite
			// throw here can't destroy the invitee's grants on other team inboxes.
			if (!reserved.result.alreadyReserved) {
				await cancelInboxMembership.run({ inviteeEmail: email, mailboxId: props.mailboxId });
			}
			throw inviteErr;
		}
		inviteNotice.value = t('components.postbox.teamInboxMembersPanel.inviteSent', { email });
		inviteEmail.value = '';
	} catch (err) {
		error.value =
			err instanceof Error
				? err.message
				: t('components.postbox.teamInboxMembersPanel.inviteFailed');
	} finally {
		inviting.value = false;
	}
}

async function handleAdd() {
	if (!memberToAdd.value) return;
	const res = await addMember.run({ mailboxId: props.mailboxId, authUserId: memberToAdd.value });
	if (!res.ok) return;
	memberToAdd.value = '';
}

async function handleRemove(authUserId: string) {
	await removeMember.run({ mailboxId: props.mailboxId, authUserId });
}

// Transferring ownership is irreversible for the current owner (only an org
// admin can undo it), so confirm before firing.
const transferTarget = ref<{ authUserId: string; label: string } | null>(null);
function askTransfer(member: { authUserId: string; name: string | null; email: string | null }) {
	transferTarget.value = {
		authUserId: member.authUserId,
		label: member.name || member.email || t('components.postbox.teamInboxMembersPanel.thisMember'),
	};
}
async function confirmTransfer() {
	const target = transferTarget.value;
	if (!target) return;
	const res = await transferOwnership.run({
		mailboxId: props.mailboxId,
		authUserId: target.authUserId,
	});
	if (!res.ok) return;
	transferTarget.value = null;
}

const busy = computed(
	() =>
		addMember.isLoading.value || removeMember.isLoading.value || transferOwnership.isLoading.value
);
</script>

<template>
	<div>
		<div v-if="error" class="text-sm text-error mb-4">{{ error }}</div>

		<!-- Add a member (owners and workspace admins only) -->
		<section v-if="canManage" class="card p-5">
			<h2 class="font-semibold mb-3">
				{{ t('components.postbox.teamInboxMembersPanel.addTitle') }}
			</h2>
			<div v-if="addableMembers.length === 0" class="text-sm text-text-secondary">
				{{ t('components.postbox.teamInboxMembersPanel.everyoneAdded') }}
			</div>
			<div v-else class="flex items-center gap-2">
				<select v-model="memberToAdd" class="input flex-1" :disabled="busy">
					<option value="">
						{{ t('components.postbox.teamInboxMembersPanel.selectTeammate') }}
					</option>
					<option v-for="m in addableMembers" :key="m.userId" :value="m.userId">
						{{
							t('components.postbox.teamInboxMembersPanel.memberOption', {
								name: m.user.name || m.user.email,
								email: m.user.email,
							})
						}}
					</option>
				</select>
				<UiButton :loading="addMember.isLoading.value" :disabled="!memberToAdd" @click="handleAdd">
					{{ t('common.add') }}
				</UiButton>
			</div>

			<!-- Invite someone who isn't in the organization yet. Requires the
			     org-admin permission that issuing an invite needs. -->
			<div v-if="canManageMembers" class="mt-5 pt-5 border-t border-border-subtle">
				<h3 class="text-sm font-medium mb-1">
					{{ t('components.postbox.teamInboxMembersPanel.notOnTeam') }}
				</h3>
				<p class="text-xs text-text-tertiary mb-3">
					{{ t('components.postbox.teamInboxMembersPanel.inviteHint') }}
				</p>
				<form class="flex items-center gap-2" @submit.prevent="handleInvite">
					<input
						v-model="inviteEmail"
						type="email"
						required
						:placeholder="t('components.postbox.teamInboxMembersPanel.emailPlaceholder')"
						class="input flex-1"
						:disabled="inviting"
						:aria-label="t('components.postbox.teamInboxMembersPanel.emailLabel')"
					/>
					<UiButton type="submit" :loading="inviting" :disabled="!inviteEmail.trim()">
						{{ t('components.postbox.teamInboxMembersPanel.sendInvite') }}
					</UiButton>
				</form>
				<p v-if="inviteNotice" class="mt-2 text-sm text-success">{{ inviteNotice }}</p>
			</div>
		</section>

		<!-- Roster -->
		<section class="card !p-0" :class="canManage ? 'mt-6' : ''">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">{{ t('components.postbox.teamInboxMembersPanel.members') }}</h2>
			</header>
			<div v-if="membersLoading && members.length === 0" class="p-8 flex justify-center">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary" />
			</div>
			<div v-else-if="membersError" class="p-6 text-sm text-error">
				{{ t('components.postbox.teamInboxMembersPanel.loadError') }}
			</div>
			<div v-else-if="members.length === 0" class="p-8 text-center text-text-secondary">
				{{ t('components.postbox.teamInboxMembersPanel.noMembers') }}
			</div>
			<ul v-else class="divide-y divide-border-subtle">
				<li
					v-for="m in members"
					:key="m._id"
					class="px-5 py-3 flex items-center justify-between gap-3"
				>
					<div class="flex items-center gap-3 min-w-0">
						<UiAvatar :name="m.name" :email="m.email" :image="m.image" deterministic-color />
						<div class="min-w-0">
							<p class="font-medium truncate">
								{{ m.name || m.email || t('components.postbox.teamInboxMembersPanel.member') }}
								<span v-if="m.isYou" class="text-xs text-text-tertiary">{{
									t('components.postbox.teamInboxMembersPanel.you')
								}}</span>
							</p>
							<p v-if="m.email" class="text-xs text-text-tertiary truncate">{{ m.email }}</p>
						</div>
					</div>
					<div class="flex items-center gap-2 shrink-0">
						<span
							class="text-xs px-2 py-0.5 rounded"
							:class="
								m.role === 'owner'
									? 'bg-brand-subtle text-brand'
									: 'bg-bg-surface text-text-tertiary'
							"
							>{{
								m.role === 'owner'
									? t('components.postbox.teamInboxMembersPanel.owner')
									: t('components.postbox.teamInboxMembersPanel.member')
							}}</span
						>
						<UiButton
							v-if="canManage && m.role !== 'owner'"
							variant="ghost"
							size="sm"
							:disabled="busy"
							:title="t('components.postbox.teamInboxMembersPanel.makeOwnerTitle')"
							@click="askTransfer(m)"
						>
							{{ t('components.postbox.teamInboxMembersPanel.makeOwner') }}
						</UiButton>
						<button
							v-if="canManage && m.role !== 'owner'"
							type="button"
							class="p-1.5 rounded text-text-tertiary hover:text-error hover:bg-error/10"
							:title="t('components.postbox.teamInboxMembersPanel.removeMember')"
							:aria-label="t('components.postbox.teamInboxMembersPanel.removeMember')"
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
			{{ t('components.postbox.teamInboxMembersPanel.readOnlyNote') }}
		</p>

		<!-- Confirm ownership transfer (irreversible for the current owner). -->
		<UiConfirmationDialog
			:open="!!transferTarget"
			:title="t('components.postbox.teamInboxMembersPanel.transferTitle')"
			:description="
				t('components.postbox.teamInboxMembersPanel.transferDescription', {
					member:
						transferTarget?.label ?? t('components.postbox.teamInboxMembersPanel.thisMemberCap'),
				})
			"
			:confirm-text="t('components.postbox.teamInboxMembersPanel.makeOwner')"
			:is-loading="transferOwnership.isLoading.value"
			@update:open="
				(v: boolean) => {
					if (!v) transferTarget = null;
				}
			"
			@confirm="confirmTransfer"
		/>
	</div>
</template>
