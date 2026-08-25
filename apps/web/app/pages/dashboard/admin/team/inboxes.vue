<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.team.inboxes.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', 'admin'],
	requiresAnyFeature: ['postbox', 'mail.external'],
});

// Team inboxes are org infrastructure: the backend list (`listShared`) and
// every roster mutation sit on the owner/admin floor, so gate the whole page
// on the same floor and avoid flashing the gate before the role resolves.
const { showAdminGate, isAdmin } = usePermissions();
const { hasActiveOrganization } = useOrganizationContext();
const { isEnabled: isFeatureEnabled } = useFeatureFlag();
const sealedMailEnabled = computed(() => isFeatureEnabled('sealedMail'));

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

const publishKeysOp = useBackendOperation(api.e2ee.keys.backfillKeys, {
	label: () => t('dashboard.admin.team.inboxes.operations.publishKeys'),
});
const rotateKeyOp = useBackendOperation(api.e2ee.lifecycle.rotateAddressKey, {
	label: () => t('dashboard.admin.team.inboxes.operations.rotateKey'),
});
const revokeKeyOp = useBackendOperation(api.e2ee.lifecycle.revokeAddressKey, {
	label: () => t('dashboard.admin.team.inboxes.operations.revokeKey'),
});
const revokeKeyTarget = ref<SharedInbox | null>(null);
const { showToast } = useToast();

async function publishMissingKeys() {
	const result = await publishKeysOp.run({});
	if (result.ok && result.result.scheduled)
		showToast(t('dashboard.admin.team.inboxes.toasts.keysScheduled'));
}

async function rotateKey(address: string) {
	const result = await rotateKeyOp.run({ address });
	if (result.ok && result.result.scheduled)
		showToast(t('dashboard.admin.team.inboxes.toasts.rotationScheduled', { address }));
}

async function confirmRevokeKey() {
	const target = revokeKeyTarget.value;
	if (!target) return;
	const result = await revokeKeyOp.run({ address: target.address });
	if (!result.ok) return;
	showToast(t('dashboard.admin.team.inboxes.toasts.keyRevoked', { address: target.address }));
	revokeKeyTarget.value = null;
}

// One inbox's management panel open at a time — the page stays scannable and
// the expanded roster is unambiguous.
const expandedId = ref<Id<'mailboxes'> | null>(null);
function toggleExpanded(id: Id<'mailboxes'>) {
	expandedId.value = expandedId.value === id ? null : id;
	if (expandedId.value) reconnectId.value = null;
}

// Which inbox's in-place credential-repair panel is open. The panel itself (and
// its non-secret prefill subscription) lives in PostboxTeamInboxCard; only the
// "one at a time" rule is the page's.
const reconnectId = ref<Id<'mailboxes'> | null>(null);
function toggleReconnect(id: Id<'mailboxes'>) {
	reconnectId.value = reconnectId.value === id ? null : id;
	if (reconnectId.value) expandedId.value = null;
}

// Deleting an external team inbox is a hard, irreversible purge: it
// cascade-deletes the mailbox, its synced mail, the roster, AND the encrypted
// credential row that otherwise lingers off-mailbox forever. `purgeShared` works
// on a live inbox directly (no prior soft-remove step), and is external-only —
// so the affordance is scoped to `kind === 'external'` inboxes.
const purgeTarget = ref<SharedInbox | null>(null);
const purgeOp = useBackendOperation(api.mail.externalSharedInbox.purgeShared, {
	label: () => t('dashboard.admin.team.inboxes.operations.deleteInbox'),
});
async function confirmPurge() {
	const target = purgeTarget.value;
	if (!target) return;
	const res = await purgeOp.run({ mailboxId: target._id });
	if (!res.ok) return;
	if (expandedId.value === target._id) expandedId.value = null;
	if (reconnectId.value === target._id) reconnectId.value = null;
	purgeTarget.value = null;
}
</script>

<template>
	<div class="p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
		<!-- Header -->
		<div class="flex items-start justify-between gap-4">
			<div>
				<NuxtLink
					to="/dashboard/admin"
					class="inline-flex items-center gap-1.5 text-sm text-text-tertiary hover:text-text-primary transition-colors mb-4"
				>
					<Icon name="lucide:arrow-left" class="w-4 h-4" />
					{{ t('dashboard.admin.team.inboxes.backToSettings') }}
				</NuxtLink>
				<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
					{{ t('dashboard.admin.team.inboxes.title') }}
				</h1>
				<I18nT
					keypath="dashboard.admin.team.inboxes.intro"
					tag="p"
					scope="global"
					class="mt-1 text-text-secondary"
				>
					<template #supportAddress><code>support@</code></template>
					<template #salesAddress><code>sales@</code></template>
				</I18nT>
			</div>
			<div v-if="!showAdminGate" class="mt-9 flex shrink-0 items-center gap-2">
				<UiButton
					v-if="sealedMailEnabled"
					variant="secondary"
					:loading="publishKeysOp.isLoading.value"
					@click="publishMissingKeys"
				>
					<Icon name="lucide:key-round" class="w-4 h-4 mr-1.5" />
					{{ t('dashboard.admin.team.inboxes.publishKeys') }}
				</UiButton>
				<UiButton to="/dashboard/preferences/add-account?mode=team">
					<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
					{{ t('dashboard.admin.team.inboxes.newInbox') }}
				</UiButton>
			</div>
		</div>

		<!-- Admins-only gate -->
		<div
			v-if="showAdminGate"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:lock" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">
				{{ t('dashboard.admin.team.inboxes.adminGate.title') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				{{ t('dashboard.admin.team.inboxes.adminGate.description') }}
			</p>
		</div>

		<!-- No organization -->
		<div
			v-else-if="!hasActiveOrganization"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:mails" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">
				{{ t('dashboard.admin.team.inboxes.noWorkspace.title') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				{{ t('dashboard.admin.team.inboxes.noWorkspace.description') }}
			</p>
		</div>

		<!-- First-load skeleton -->
		<div v-else-if="isLoading && !inboxes" class="card overflow-hidden">
			<DashboardListSkeleton variant="card" leading :rows="3" />
		</div>

		<!-- Error -->
		<UiErrorAlert v-else-if="error" :message="t('dashboard.admin.team.inboxes.loadError')" />

		<!-- Empty state -->
		<div v-else-if="(inboxes?.length ?? 0) === 0" class="card py-16 px-6 text-center">
			<UiIconBox
				icon="lucide:mails"
				size="xl"
				variant="surface"
				rounded="full"
				class="mb-4 mx-auto"
			/>
			<h2 class="font-semibold text-text-primary">
				{{ t('dashboard.admin.team.inboxes.empty.title') }}
			</h2>
			<I18nT
				keypath="dashboard.admin.team.inboxes.empty.description"
				tag="p"
				scope="global"
				class="text-sm text-text-secondary mt-2 max-w-md mx-auto"
			>
				<template #supportAddress><code>support@</code></template>
			</I18nT>
			<UiButton to="/dashboard/preferences/add-account?mode=team" class="mt-6">
				<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
				{{ t('dashboard.admin.team.inboxes.empty.action') }}
			</UiButton>
		</div>

		<!-- Inbox list -->
		<div v-else class="space-y-4">
			<PostboxTeamInboxCard
				v-for="inbox in inboxes"
				:key="inbox._id"
				:inbox="inbox"
				:expanded="expandedId === inbox._id"
				:reconnecting="reconnectId === inbox._id"
				:sealed-mail-enabled="sealedMailEnabled"
				@toggle-expanded="toggleExpanded(inbox._id)"
				@toggle-reconnect="toggleReconnect(inbox._id)"
				@open="switchToMailbox(inbox._id)"
				@rotate-key="rotateKey(inbox.address)"
				@revoke-key="revokeKeyTarget = inbox"
				@purge="purgeTarget = inbox"
				@reconnected="reconnectId = null"
			/>
		</div>

		<UiConfirmationDialog
			:open="!!revokeKeyTarget"
			variant="danger"
			:title="t('dashboard.admin.team.inboxes.revokeKeyDialog.title')"
			:description="
				t('dashboard.admin.team.inboxes.revokeKeyDialog.description', {
					address:
						revokeKeyTarget?.address ?? t('dashboard.admin.team.inboxes.revokeKeyDialog.thisInbox'),
				})
			"
			:confirm-text="t('dashboard.admin.team.inboxes.revokeKeyDialog.confirm')"
			:is-loading="revokeKeyOp.isLoading.value"
			@update:open="(open: boolean) => !open && (revokeKeyTarget = null)"
			@confirm="confirmRevokeKey"
		/>

		<!-- Hard-delete confirmation: purges the mailbox, its mail, the roster, and
		     the encrypted credential row. Irreversible, so gate it behind a dialog. -->
		<UiConfirmationDialog
			:open="purgeTarget !== null"
			variant="danger"
			:title="t('dashboard.admin.team.inboxes.deleteDialog.title')"
			:description="
				t('dashboard.admin.team.inboxes.deleteDialog.description', {
					name: purgeTarget?.displayName || purgeTarget?.address,
				})
			"
			:confirm-text="t('dashboard.admin.team.inboxes.deleteDialog.confirm')"
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
