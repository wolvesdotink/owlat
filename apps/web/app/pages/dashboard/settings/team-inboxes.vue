<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { GENERIC_IMAP_PROVIDER } from '~/utils/mailAutodiscover';

useHead({ title: 'Team inboxes — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

// Team inboxes are org infrastructure: the backend list (`listShared`) and
// every roster mutation sit on the owner/admin floor, so gate the whole page
// on the same floor and avoid flashing the gate before the role resolves.
const { showAdminGate, isAdmin } = usePermissions();
const { hasActiveOrganization } = useOrganizationContext();

// `listShared` throws for non-admins (adminQuery), so only subscribe once the
// caller's role has resolved to owner/admin — the gate renders for everyone else.
const {
	data: inboxes,
	isLoading,
	error,
} = useConvexQuery(api.mail.mailboxMembers.listShared, () => (isAdmin.value ? {} : 'skip'));

type SharedInbox = NonNullable<typeof inboxes.value>[number];

// "Open inbox" makes the selected team inbox the active Postbox mailbox and
// lands on its inbox — the same switch the sidebar switcher and Cmd-K perform.
const { switchToMailbox } = usePostboxMailbox();

// One inbox's management panel open at a time — the page stays scannable and
// the expanded roster is unambiguous.
const expandedId = ref<Id<'mailboxes'> | null>(null);
function toggleExpanded(id: Id<'mailboxes'>) {
	expandedId.value = expandedId.value === id ? null : id;
	if (expandedId.value) reconnectId.value = null;
}

// An external team inbox whose credentials stopped working (a rotated app
// password → auth_error). The credentials live off the mailbox on the shared
// external account, so `listShared` surfaces that account's status.
function hasConnectionError(inbox: SharedInbox): boolean {
	return (
		inbox.kind === 'external' &&
		(inbox.externalStatus === 'auth_error' || inbox.externalStatus === 'error')
	);
}

// Reconnect is only reachable on an ACTIVE inbox: `getSharedExternalAccount`
// (the form's prefill) and `_updateCredentialsSharedInternal` both go through
// `requireMailboxAccess`, which refuses a non-active mailbox — so offering the
// button on a suspended inbox would open an empty, formless panel. A suspended
// inbox with a broken connection is surfaced via `reconnectBlocked` instead.
function needsReconnect(inbox: SharedInbox): boolean {
	return hasConnectionError(inbox) && inbox.status === 'active';
}

// A broken connection the admin can't repair yet because the inbox is suspended:
// show the problem, but explain the block rather than dead-ending on a button.
function reconnectBlocked(inbox: SharedInbox): boolean {
	return hasConnectionError(inbox) && inbox.status !== 'active';
}

// The reconnect form's non-secret prefill (servers, username) comes from the
// linked account; only the panel that's open subscribes.
const reconnectId = ref<Id<'mailboxes'> | null>(null);
function toggleReconnect(id: Id<'mailboxes'>) {
	reconnectId.value = reconnectId.value === id ? null : id;
	if (reconnectId.value) expandedId.value = null;
}
const { data: reconnectAccount } = useConvexQuery(
	api.mail.externalSharedInbox.getSharedExternalAccount,
	() => (reconnectId.value ? { mailboxId: reconnectId.value } : 'skip')
);
const reconnectAccountForForm = computed(() =>
	reconnectAccount.value?.configured ? reconnectAccount.value : null
);
function onReconnected() {
	reconnectId.value = null;
}

// Deleting an external team inbox is a hard, irreversible purge: it
// cascade-deletes the mailbox, its synced mail, the roster, AND the encrypted
// credential row that otherwise lingers off-mailbox forever. `purgeShared` works
// on a live inbox directly (no prior soft-remove step), and is external-only —
// so the affordance is scoped to `kind === 'external'` inboxes.
const purgeTarget = ref<SharedInbox | null>(null);
const purgeOp = useBackendOperation(api.mail.externalSharedInbox.purgeShared, {
	label: 'Delete team inbox',
});
async function confirmPurge() {
	const target = purgeTarget.value;
	if (!target) return;
	const res = await purgeOp.run({ mailboxId: target._id });
	if (!res) return;
	if (expandedId.value === target._id) expandedId.value = null;
	if (reconnectId.value === target._id) reconnectId.value = null;
	purgeTarget.value = null;
}

function ownerOf(inbox: SharedInbox) {
	const owner = inbox.members.find((m) => m.role === 'owner');
	return owner ? owner.name || owner.email || owner.authUserId : null;
}

const AVATAR_PREVIEW_LIMIT = 5;
function avatarPreview(inbox: SharedInbox) {
	return inbox.members.slice(0, AVATAR_PREVIEW_LIMIT);
}

function formatCreated(createdAt: number) {
	return new Date(createdAt).toLocaleDateString(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}
</script>

<template>
	<div class="p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
		<!-- Header -->
		<div class="flex items-start justify-between gap-4">
			<div>
				<NuxtLink
					to="/dashboard/settings"
					class="inline-flex items-center gap-1.5 text-sm text-text-tertiary hover:text-text-primary transition-colors mb-4"
				>
					<Icon name="lucide:arrow-left" class="w-4 h-4" />
					Back to Settings
				</NuxtLink>
				<h1 class="text-2xl font-semibold text-text-primary">Team inboxes</h1>
				<p class="mt-1 text-text-secondary">
					Shared addresses your team reads and sends from together — like
					<code>support@</code> or <code>sales@</code>.
				</p>
			</div>
			<NuxtLink
				v-if="!showAdminGate"
				to="/dashboard/postbox/settings/add-account?mode=team"
				class="btn btn-primary shrink-0 mt-9"
			>
				<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
				New team inbox
			</NuxtLink>
		</div>

		<!-- Admins-only gate -->
		<div
			v-if="showAdminGate"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:lock" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">Admins only</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				Team inboxes can be managed by workspace owners and admins.
			</p>
		</div>

		<!-- No organization -->
		<div
			v-else-if="!hasActiveOrganization"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:mails" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">No workspace selected</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				Create or select a workspace to manage team inboxes.
			</p>
		</div>

		<!-- First-load skeleton -->
		<div v-else-if="isLoading && !inboxes" class="card overflow-hidden">
			<DashboardListSkeleton variant="card" leading :rows="3" />
		</div>

		<!-- Error -->
		<UiErrorAlert v-else-if="error" message="Could not load team inboxes. Please try again." />

		<!-- Empty state -->
		<div v-else-if="(inboxes?.length ?? 0) === 0" class="card py-16 px-6 text-center">
			<UiIconBox
				icon="lucide:mails"
				size="xl"
				variant="surface"
				rounded="full"
				class="mb-4 mx-auto"
			/>
			<h2 class="font-semibold text-text-primary">No team inboxes yet</h2>
			<p class="text-sm text-text-secondary mt-2 max-w-md mx-auto">
				Create a shared address like <code>support@</code> so your whole team can read and reply
				from one place. You choose who's a member; everyone else can't see it.
			</p>
			<NuxtLink to="/dashboard/postbox/settings/add-account?mode=team" class="btn btn-primary mt-6">
				<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
				Create your first team inbox
			</NuxtLink>
		</div>

		<!-- Inbox list -->
		<div v-else class="space-y-4">
			<div v-for="inbox in inboxes" :key="inbox._id" class="card !p-0 overflow-hidden">
				<div class="p-5">
					<div class="flex items-start justify-between gap-4">
						<div class="flex items-center gap-3 min-w-0">
							<UiIconBox icon="lucide:mails" size="md" variant="surface" rounded="lg" />
							<div class="min-w-0">
								<p class="font-semibold text-text-primary truncate">
									{{ inbox.displayName || inbox.address }}
								</p>
								<p class="text-sm text-text-tertiary truncate">
									<code>{{ inbox.address }}</code>
								</p>
							</div>
						</div>
						<div class="flex items-center gap-2 shrink-0">
							<span
								v-if="inbox.status === 'suspended'"
								class="text-xs px-2 py-0.5 rounded bg-warning/10 text-warning"
							>
								Suspended
							</span>
							<span
								v-if="hasConnectionError(inbox)"
								class="text-xs px-2 py-0.5 rounded bg-error/10 text-error"
								:title="inbox.externalLastError || undefined"
							>
								Needs attention
							</span>
							<span
								v-if="inbox.kind === 'external'"
								class="text-xs px-2 py-0.5 rounded bg-bg-surface text-text-tertiary"
							>
								External
							</span>
							<UiButton
								v-if="needsReconnect(inbox)"
								variant="secondary"
								size="sm"
								:aria-expanded="reconnectId === inbox._id"
								@click="toggleReconnect(inbox._id)"
							>
								<Icon name="lucide:refresh-cw" class="w-4 h-4 mr-1.5" />
								{{ reconnectId === inbox._id ? 'Cancel' : 'Reconnect' }}
							</UiButton>
							<UiButton
								variant="ghost"
								size="sm"
								title="Make this the active mailbox in Postbox"
								@click="switchToMailbox(inbox._id)"
							>
								<Icon name="lucide:arrow-right" class="w-4 h-4 mr-1.5" />
								Open inbox
							</UiButton>
							<UiButton
								variant="secondary"
								size="sm"
								:aria-expanded="expandedId === inbox._id"
								@click="toggleExpanded(inbox._id)"
							>
								<Icon
									:name="expandedId === inbox._id ? 'lucide:chevron-up' : 'lucide:users'"
									class="w-4 h-4 mr-1.5"
								/>
								{{ expandedId === inbox._id ? 'Done' : 'Manage members' }}
							</UiButton>
							<UiButton
								v-if="inbox.kind === 'external'"
								variant="ghost"
								size="sm"
								class="text-error hover:text-error"
								title="Delete this team inbox permanently"
								@click="purgeTarget = inbox"
							>
								<Icon name="lucide:trash-2" class="w-4 h-4" />
							</UiButton>
						</div>
					</div>

					<div class="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
						<!-- Member avatar stack -->
						<div class="flex items-center gap-2">
							<div class="flex -space-x-1.5">
								<UiAvatar
									v-for="m in avatarPreview(inbox)"
									:key="m.authUserId"
									:name="m.name"
									:email="m.email"
									:image="m.image"
									deterministic-color
									class="ring-2 ring-bg-base rounded-full"
								/>
							</div>
							<span class="text-text-secondary">
								{{ inbox.memberCount }} {{ inbox.memberCount === 1 ? 'member' : 'members'
								}}<template v-if="inbox.memberCount > AVATAR_PREVIEW_LIMIT">
									(+{{ inbox.memberCount - AVATAR_PREVIEW_LIMIT }} more)</template
								>
							</span>
						</div>
						<span v-if="ownerOf(inbox)" class="text-text-tertiary">
							Owned by {{ ownerOf(inbox) }}
						</span>
						<span class="text-text-tertiary">Created {{ formatCreated(inbox.createdAt) }}</span>
					</div>

					<!-- Pending invites: reserved memberships waiting on org-invite acceptance. -->
					<p
						v-if="inbox.pendingInvites.length > 0"
						class="mt-3 text-xs text-text-tertiary flex items-center gap-1.5"
					>
						<Icon name="lucide:mail-plus" class="w-3.5 h-3.5" />
						{{ inbox.pendingInvites.length }}
						{{ inbox.pendingInvites.length === 1 ? 'invitation' : 'invitations' }} pending:
						{{ inbox.pendingInvites.join(', ') }}
					</p>

					<!-- Connection is broken but the inbox is suspended, so the in-place
					     reconnect (which needs an active mailbox) isn't available yet. -->
					<p
						v-if="reconnectBlocked(inbox)"
						class="mt-3 text-xs text-text-tertiary flex items-start gap-1.5"
					>
						<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5 mt-0.5 shrink-0" />
						<span>
							This inbox's mail connection stopped working, but it's suspended — restore it
							first to reconnect the mailbox.
						</span>
					</p>
				</div>

				<!-- Inline member management (same panel the Postbox settings page uses). -->
				<div
					v-if="expandedId === inbox._id"
					class="border-t border-border-subtle bg-bg-surface/40 p-5"
				>
					<PostboxTeamInboxMembersPanel :mailbox-id="inbox._id" />
				</div>

				<!-- Inline credential repair: rotate the shared external account's
				     password when its connection broke (auth_error). -->
				<div
					v-if="reconnectId === inbox._id"
					class="border-t border-border-subtle bg-bg-surface/40 p-5 space-y-4"
				>
					<div>
						<h3 class="font-semibold text-text-primary">Reconnect this inbox</h3>
						<p class="text-sm text-text-secondary mt-1">
							Its mail connection stopped working. Re-enter the mailbox password (an app
							password if the provider requires one) to resume syncing. Your team and its mail
							are kept.
						</p>
						<p v-if="inbox.externalLastError" class="text-xs text-error mt-2">
							{{ inbox.externalLastError }}
						</p>
					</div>
					<PostboxMailboxConnectForm
						v-if="reconnectAccountForForm"
						:provider="GENERIC_IMAP_PROVIDER"
						mode="update"
						shared
						:mailbox-id="inbox._id"
						:account="reconnectAccountForForm"
						@submitted="onReconnected"
						@cancel="reconnectId = null"
					/>
				</div>
			</div>
		</div>

		<!-- Hard-delete confirmation: purges the mailbox, its mail, the roster, and
		     the encrypted credential row. Irreversible, so gate it behind a dialog. -->
		<UiConfirmationDialog
			:open="purgeTarget !== null"
			variant="danger"
			title="Delete team inbox permanently?"
			:description="`Delete &quot;${purgeTarget?.displayName || purgeTarget?.address}&quot;? Its synced mail, the member roster, and the stored mailbox connection are erased for everyone. This cannot be undone.`"
			confirm-text="Delete permanently"
			:is-loading="purgeOp.isLoading.value"
			@update:open="
				(v: boolean) => {
					if (!v) purgeTarget = null;
				}
			"
			@confirm="confirmPurge"
		/>
	</div>
</template>
