<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

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

// One inbox's management panel open at a time — the page stays scannable and
// the expanded roster is unambiguous.
const expandedId = ref<Id<'mailboxes'> | null>(null);
function toggleExpanded(id: Id<'mailboxes'>) {
	expandedId.value = expandedId.value === id ? null : id;
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
								v-if="inbox.kind === 'external'"
								class="text-xs px-2 py-0.5 rounded bg-bg-surface text-text-tertiary"
							>
								External
							</span>
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
				</div>

				<!-- Inline member management (same panel the Postbox settings page uses). -->
				<div
					v-if="expandedId === inbox._id"
					class="border-t border-border-subtle bg-bg-surface/40 p-5"
				>
					<PostboxTeamInboxMembersPanel :mailbox-id="inbox._id" />
				</div>
			</div>
		</div>
	</div>
</template>
