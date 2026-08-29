<script setup lang="ts">
/**
 * ONE team inbox, as the admin roster page shows it: identity, badges, the row
 * of affordances, the member summary, and the two panels that open in place
 * (member management and external-credential repair).
 *
 * Everything here is about a SINGLE inbox. The page above owns what is true
 * ACROSS inboxes — which panel is open (only one at a time), the destructive
 * confirmation dialogs, and the mutations themselves — so this component asks
 * rather than acts: it reports intent through events and renders the state the
 * page hands back.
 */
import type { FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import { GENERIC_IMAP_PROVIDER } from '~/utils/mailAutodiscover';

type SharedInbox = FunctionReturnType<typeof api.mail.mailboxMembers.listShared>[number];

const props = defineProps<{
	inbox: SharedInbox;
	/** The member-management panel is the one currently open on the page. */
	expanded: boolean;
	/** The credential-repair panel is the one currently open on the page. */
	reconnecting: boolean;
	sealedMailEnabled: boolean;
}>();

const emit = defineEmits<{
	toggleExpanded: [];
	toggleReconnect: [];
	open: [];
	rotateKey: [];
	revokeKey: [];
	purge: [];
	reconnected: [];
}>();

const { t, locale } = useI18n();

// An external team inbox whose credentials stopped working (a rotated app
// password → auth_error). The credentials live off the mailbox on the shared
// external account, so `listShared` surfaces that account's status.
const hasConnectionError = computed(
	() =>
		props.inbox.kind === 'external' &&
		(props.inbox.externalStatus === 'auth_error' || props.inbox.externalStatus === 'error')
);

// Reconnect is only reachable on an ACTIVE inbox: `getSharedExternalAccount`
// (the form's prefill) and `_updateCredentialsSharedInternal` both go through
// `requireMailboxAccess`, which refuses a non-active mailbox — so offering the
// button on a suspended inbox would open an empty, formless panel. A suspended
// inbox with a broken connection is surfaced via `reconnectBlocked` instead.
const needsReconnect = computed(() => hasConnectionError.value && props.inbox.status === 'active');

// A broken connection the admin can't repair yet because the inbox is suspended:
// show the problem, but explain the block rather than dead-ending on a button.
const reconnectBlocked = computed(
	() => hasConnectionError.value && props.inbox.status !== 'active'
);

// The reconnect form's non-secret prefill (servers, username) comes from the
// linked account; only the panel that's open subscribes.
const { data: reconnectAccount, isLoading: reconnectLoading } = useConvexQuery(
	api.mail.external.sharedInbox.getSharedExternalAccount,
	() => (props.reconnecting ? { mailboxId: props.inbox._id } : 'skip')
);
const reconnectAccountForForm = computed(() =>
	reconnectAccount.value?.configured ? reconnectAccount.value : null
);

const owner = computed(() => {
	const found = props.inbox.members.find((m) => m.role === 'owner');
	return found ? found.name || found.email || found.authUserId : null;
});

const AVATAR_PREVIEW_LIMIT = 5;
const avatarPreview = computed(() => props.inbox.members.slice(0, AVATAR_PREVIEW_LIMIT));

const createdOn = computed(() =>
	new Intl.DateTimeFormat(locale.value, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	}).format(new Date(props.inbox.createdAt))
);
</script>

<template>
	<div class="card !p-0 overflow-hidden">
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
						{{ t('dashboard.admin.team.inboxes.badges.suspended') }}
					</span>
					<span
						v-if="hasConnectionError"
						class="text-xs px-2 py-0.5 rounded bg-error/10 text-error"
						:title="inbox.externalLastError || undefined"
					>
						{{ t('dashboard.admin.team.inboxes.badges.needsAttention') }}
					</span>
					<span
						v-if="inbox.kind === 'external'"
						class="text-xs px-2 py-0.5 rounded bg-bg-surface text-text-tertiary"
					>
						{{ t('dashboard.admin.team.inboxes.badges.external') }}
					</span>
					<UiButton
						v-if="needsReconnect"
						variant="secondary"
						size="sm"
						:aria-expanded="reconnecting"
						@click="emit('toggleReconnect')"
					>
						<Icon name="lucide:refresh-cw" class="w-4 h-4 mr-1.5" />
						{{ reconnecting ? t('common.cancel') : t('dashboard.admin.team.inboxes.reconnect') }}
					</UiButton>
					<UiButton
						variant="ghost"
						size="sm"
						:title="t('dashboard.admin.team.inboxes.openInboxTitle')"
						@click="emit('open')"
					>
						<Icon name="lucide:arrow-right" class="w-4 h-4 mr-1.5" />
						{{ t('dashboard.admin.team.inboxes.openInbox') }}
					</UiButton>
					<UiButton
						variant="secondary"
						size="sm"
						:aria-expanded="expanded"
						@click="emit('toggleExpanded')"
					>
						<Icon :name="expanded ? 'lucide:chevron-up' : 'lucide:users'" class="w-4 h-4 mr-1.5" />
						{{ expanded ? t('common.done') : t('dashboard.admin.team.inboxes.manageMembers') }}
					</UiButton>
					<UiButton
						v-if="sealedMailEnabled"
						variant="ghost"
						size="sm"
						:title="t('dashboard.admin.team.inboxes.rotateKeyTitle')"
						@click="emit('rotateKey')"
					>
						<Icon name="lucide:key-round" class="w-4 h-4" />
					</UiButton>
					<UiButton
						v-if="sealedMailEnabled"
						variant="ghost"
						size="sm"
						class="text-error hover:text-error"
						:title="t('dashboard.admin.team.inboxes.revokeKeyTitle')"
						@click="emit('revokeKey')"
					>
						<Icon name="lucide:key-round-x" class="w-4 h-4" />
					</UiButton>
					<UiButton
						v-if="inbox.kind === 'external'"
						variant="ghost"
						size="sm"
						class="text-error hover:text-error"
						:title="t('dashboard.admin.team.inboxes.deleteInboxTitle')"
						@click="emit('purge')"
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
							v-for="m in avatarPreview"
							:key="m.authUserId"
							:name="m.name"
							:email="m.email"
							:image="m.image"
							deterministic-color
							class="ring-2 ring-bg-base rounded-full"
						/>
					</div>
					<span class="text-text-secondary">
						{{ t('dashboard.admin.team.inboxes.memberCount', inbox.memberCount)
						}}<template v-if="inbox.memberCount > AVATAR_PREVIEW_LIMIT">
							{{
								t('dashboard.admin.team.inboxes.moreMembers', {
									count: inbox.memberCount - AVATAR_PREVIEW_LIMIT,
								})
							}}</template
						>
					</span>
				</div>
				<span v-if="owner" class="text-text-tertiary">
					{{ t('dashboard.admin.team.inboxes.ownedBy', { owner }) }}
				</span>
				<span class="text-text-tertiary">
					{{ t('dashboard.admin.team.inboxes.createdOn', { date: createdOn }) }}
				</span>
			</div>

			<!-- Pending invites: reserved memberships waiting on org-invite acceptance. -->
			<p
				v-if="inbox.pendingInvites.length > 0"
				class="mt-3 text-xs text-text-tertiary flex items-center gap-1.5"
			>
				<Icon name="lucide:mail-plus" class="w-3.5 h-3.5" />
				{{
					t(
						'dashboard.admin.team.inboxes.pendingInvites',
						{
							count: inbox.pendingInvites.length,
							invitees: inbox.pendingInvites.join(', '),
						},
						inbox.pendingInvites.length
					)
				}}
			</p>

			<!-- Connection is broken but the inbox is suspended, so the in-place
			     reconnect (which needs an active mailbox) isn't available yet. -->
			<p v-if="reconnectBlocked" class="mt-3 text-xs text-text-tertiary flex items-start gap-1.5">
				<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5 mt-0.5 shrink-0" />
				<span>{{ t('dashboard.admin.team.inboxes.reconnectBlocked') }}</span>
			</p>
		</div>

		<!-- Inline member management (same panel the Postbox settings page uses). -->
		<div v-if="expanded" class="border-t border-border-subtle bg-bg-surface/40 p-5">
			<PostboxTeamInboxMembersPanel :mailbox-id="inbox._id" />
		</div>

		<!-- Inline credential repair: rotate the shared external account's
		     password when its connection broke (auth_error). -->
		<div v-if="reconnecting" class="border-t border-border-subtle bg-bg-surface/40 p-5 space-y-4">
			<div>
				<h3 class="font-semibold text-text-primary">
					{{ t('dashboard.admin.team.inboxes.reconnectPanel.title') }}
				</h3>
				<p class="text-sm text-text-secondary mt-1">
					{{ t('dashboard.admin.team.inboxes.reconnectPanel.description') }}
				</p>
				<p v-if="inbox.externalLastError" class="text-xs text-error mt-2">
					{{ inbox.externalLastError }}
				</p>
			</div>
			<!-- The form's non-secret prefill (servers, username) comes from the
			     getSharedExternalAccount subscription; show a pending state until it
			     resolves so the panel isn't briefly empty and formless. -->
			<div v-if="reconnectLoading && !reconnectAccountForForm" class="p-4 flex justify-center">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary" />
			</div>
			<PostboxMailboxConnectForm
				v-else-if="reconnectAccountForForm"
				:provider="GENERIC_IMAP_PROVIDER"
				mode="update"
				shared
				:mailbox-id="inbox._id"
				:account="reconnectAccountForForm"
				@submitted="emit('reconnected')"
				@cancel="emit('toggleReconnect')"
			/>
		</div>
	</div>
</template>
