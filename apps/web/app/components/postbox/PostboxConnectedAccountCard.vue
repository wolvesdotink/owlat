<script setup lang="ts">
/**
 * The connected mailbox, and the two ways out of it.
 *
 * Disconnecting used to be reachable from exactly one screen state: the import
 * wizard, connected, before an import had ever been started. Everyone past that
 * point — which is everyone, an import finishes — had no way to end the
 * connection at all. So this card owns the whole lifecycle in one place and
 * both surfaces render it: Settings (where someone looks for it) and the wizard
 * (where they happen to be).
 *
 * Three states, because the account has three:
 *   - connected: change the password, disconnect, or delete it outright;
 *   - disconnected with mail kept: reconnect, or delete what was kept. The
 *     backend re-attaches this same mailbox when the same address is connected
 *     again, so "kept" means the mail comes back, not that it sits in a row
 *     nobody can reach;
 *   - nothing connected: point at the wizard.
 *
 * Disconnect stops the sync and drops the stored password. Delete additionally
 * erases the mail, and says so before it runs.
 */
import { api } from '@owlat/api';
import { GENERIC_IMAP_PROVIDER, MAIL_PROVIDERS, type MailProvider } from '~/utils/mailAutodiscover';

const props = withDefaults(
	defineProps<{
		/** Render the "connect one" prompt when nothing is connected. */
		showEmptyState?: boolean;
		/**
		 * Offer "Update password". The import wizard's reconnect step already puts
		 * that exact form on screen, and two copies of it collide on their field
		 * ids — so there it asks for one and suppresses this one.
		 */
		showCredentialUpdate?: boolean;
	}>(),
	{ showEmptyState: true, showCredentialUpdate: true }
);

const { t, locale } = useI18n();
const { showToast } = useToast();

// `mail.external` is off by default and the backend query asserts it, so an
// instance without the feature never subscribes and the card self-hides.
const { isEnabled } = useFeatureFlag();
const flagEnabled = computed(() => isEnabled('mail.external'));

const {
	data: accountData,
	isLoading,
	error: accountError,
} = useConvexQuery(api.mail.external.accounts.getForCurrentUser, () =>
	flagEnabled.value ? {} : 'skip'
);

/** The live connection, or null when nothing is syncing. */
const account = computed(() => (accountData.value?.configured ? accountData.value : null));
/** A mailbox a previous disconnect kept: reconnectable, or deletable. */
const retained = computed(() =>
	accountData.value && !accountData.value.configured ? (accountData.value.retained ?? null) : null
);

// An import in flight is the one thing disconnecting interrupts, so the
// confirmation says so rather than letting a progress bar die quietly.
const { data: migration } = useConvexQuery(api.mail.migration.getStatus, () =>
	flagEnabled.value && account.value ? {} : 'skip'
);
const isImporting = computed(
	() => migration.value?.status === 'importing' || migration.value?.status === 'indexing'
);

const statusKey = computed(() => {
	const status = account.value?.status;
	if (status === 'connected') return 'connected';
	if (status === 'auth_error') return 'authError';
	if (status === 'error') return 'error';
	return 'pending';
});
const isHealthy = computed(() => account.value?.status === 'connected');
const needsAttention = computed(
	() => account.value?.status === 'auth_error' || account.value?.status === 'error'
);

const dateFormat = computed(
	() =>
		new Intl.DateTimeFormat(locale.value, {
			dateStyle: 'medium',
			timeStyle: 'short',
		})
);
const lastSynced = computed(() =>
	account.value?.lastSyncAt ? dateFormat.value.format(new Date(account.value.lastSyncAt)) : null
);
const disconnectedOn = computed(() =>
	retained.value ? dateFormat.value.format(new Date(retained.value.disconnectedAt)) : null
);

// The provider behind the stored server settings, so the credential form keeps
// that provider's guidance. An unrecognized host falls back to the generic form.
const connectedProvider = computed<MailProvider>(() => {
	const host = account.value?.imapHost.toLowerCase() ?? '';
	const match = MAIL_PROVIDERS.find((p) => p.preset && host === p.preset.imapHost.toLowerCase());
	return match ?? GENERIC_IMAP_PROVIDER;
});

const route = useRoute();
const WIZARD_PATH = '/dashboard/postbox/migrate';
/**
 * Connecting again is the wizard's job. When this card is rendered ON the wizard
 * the form is already above it, so navigating there would be a click that does
 * nothing — scroll to it instead.
 */
function goConnect() {
	if (route.path === WIZARD_PATH) {
		window.scrollTo({ top: 0, behavior: 'smooth' });
		return;
	}
	void navigateTo(WIZARD_PATH);
}

// A Google-authorized mailbox has no password to re-enter — the form offers
// "Reconnect with Google" instead — so the button that opens it must not promise
// a password field.
const usesOauth = computed(() => account.value?.authMethod === 'oauth2');

const editing = ref(false);
function handleUpdated() {
	editing.value = false;
	showToast(t('components.postbox.postboxConnectedAccountCard.toastCredentialsUpdated'), 'success');
}

const disconnectOp = useBackendOperation(api.mail.external.accounts.disconnect, {
	label: () => t('components.postbox.postboxConnectedAccountCard.disconnectOperation'),
});
const deleteOp = useBackendOperation(api.mail.external.accounts.purge, {
	label: () => t('components.postbox.postboxConnectedAccountCard.deleteOperation'),
});

const confirming = ref<'disconnect' | 'delete' | null>(null);
// The delete cascades in scheduled chunks, so the account keeps reading back for
// a while after the mutation returns. Hold the truth locally until the row is
// actually gone, or the card would answer "your mail is still here" the instant
// someone asked for it to be erased.
const deleting = ref(false);
watch(accountData, (value) => {
	if (deleting.value && value && !value.configured && !value.retained) deleting.value = false;
});

async function confirmDisconnect() {
	const result = await disconnectOp.run({});
	confirming.value = null;
	if (!result.ok) return;
	editing.value = false;
	showToast(t('components.postbox.postboxConnectedAccountCard.toastDisconnected'), 'success');
}

async function confirmDelete() {
	const result = await deleteOp.run({});
	confirming.value = null;
	if (!result.ok) return;
	deleting.value = true;
	editing.value = false;
	showToast(t('components.postbox.postboxConnectedAccountCard.toastDeleting'), 'success');
}

const showCard = computed(
	() =>
		flagEnabled.value &&
		(props.showEmptyState ||
			!!account.value ||
			!!retained.value ||
			deleting.value ||
			!!accountError.value)
);
</script>

<template>
	<section
		v-if="showCard"
		id="connected-account"
		class="card !p-0 scroll-mt-6"
		aria-labelledby="connected-account-heading"
		data-testid="connected-account-card"
	>
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 id="connected-account-heading" class="font-semibold">
				{{ t('components.postbox.postboxConnectedAccountCard.heading') }}
			</h2>
		</header>

		<div v-if="isLoading" class="p-8 flex justify-center" aria-busy="true">
			<Icon
				name="lucide:loader-2"
				class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary"
			/>
			<span class="sr-only">{{ t('components.postbox.postboxConnectedAccountCard.loading') }}</span>
		</div>

		<!-- The subscription faulted. Saying nothing here would render as "no
		     mailbox is connected", which is a different and wrong answer. -->
		<div v-else-if="accountError" class="px-5 py-6 flex items-start gap-3" role="alert">
			<Icon name="lucide:alert-triangle" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
			<p class="text-sm text-text-secondary">
				{{ t('components.postbox.postboxConnectedAccountCard.loadError') }}
			</p>
		</div>

		<!-- The delete is cascading in the background. -->
		<div
			v-else-if="deleting"
			class="px-5 py-6 flex items-start gap-3"
			data-testid="connected-account-deleting"
		>
			<Icon
				name="lucide:loader-2"
				class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary shrink-0 mt-0.5"
			/>
			<p class="text-sm text-text-secondary">
				{{ t('components.postbox.postboxConnectedAccountCard.deletingBody') }}
			</p>
		</div>

		<!-- Connected: the address, how it's doing, and the way out. -->
		<div v-else-if="account" class="p-5">
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div class="min-w-0">
					<p class="font-medium truncate" data-testid="connected-account-address">
						{{ account.emailAddress }}
					</p>
					<p v-if="lastSynced" class="text-xs text-text-tertiary mt-0.5">
						{{
							t('components.postbox.postboxConnectedAccountCard.lastSynced', { when: lastSynced })
						}}
					</p>
					<p v-else class="text-xs text-text-tertiary mt-0.5">
						{{ t('components.postbox.postboxConnectedAccountCard.neverSynced') }}
					</p>
				</div>
				<span
					class="text-xs px-2 py-0.5 rounded shrink-0"
					:class="
						isHealthy
							? 'bg-success-subtle text-success'
							: needsAttention
								? 'bg-error/10 text-error'
								: 'bg-bg-surface text-text-tertiary'
					"
					data-testid="connected-account-status"
				>
					{{ t(`components.postbox.postboxConnectedAccountCard.status.${statusKey}`) }}
				</span>
			</div>

			<p v-if="needsAttention" class="text-sm text-error mt-3">
				{{ account.lastError ?? t('components.postbox.postboxConnectedAccountCard.errorFallback') }}
			</p>

			<div v-if="!editing" class="mt-4 flex flex-wrap items-center gap-3">
				<UiButton v-if="showCredentialUpdate" variant="secondary" size="sm" @click="editing = true">
					{{
						usesOauth
							? t('components.postbox.postboxConnectedAccountCard.reauthorize')
							: t('components.postbox.postboxConnectedAccountCard.updateCredentials')
					}}
				</UiButton>
				<UiButton
					variant="ghost"
					size="sm"
					class="text-error"
					data-testid="connected-account-disconnect"
					@click="confirming = 'disconnect'"
				>
					{{ t('components.postbox.postboxConnectedAccountCard.disconnect') }}
				</UiButton>
				<UiButton
					variant="ghost"
					size="sm"
					class="text-error"
					data-testid="connected-account-delete"
					@click="confirming = 'delete'"
				>
					{{ t('components.postbox.postboxConnectedAccountCard.delete') }}
				</UiButton>
			</div>

			<div v-else class="mt-4 rounded-lg border border-border-subtle p-4">
				<PostboxMailboxConnectForm
					:provider="connectedProvider"
					mode="update"
					:account="account"
					@submitted="handleUpdated"
					@cancel="editing = false"
				/>
			</div>
		</div>

		<!-- Disconnected, mail kept. Two honest ways forward. -->
		<div v-else-if="retained" class="p-5" data-testid="connected-account-retained">
			<p class="font-medium truncate">{{ retained.emailAddress }}</p>
			<p v-if="disconnectedOn" class="text-xs text-text-tertiary mt-0.5">
				{{
					t('components.postbox.postboxConnectedAccountCard.disconnectedOn', {
						when: disconnectedOn,
					})
				}}
			</p>
			<p class="text-sm text-text-secondary mt-3">
				{{
					retained.canReattach
						? t('components.postbox.postboxConnectedAccountCard.retainedBody')
						: t('components.postbox.postboxConnectedAccountCard.retainedRemovedBody')
				}}
			</p>
			<div class="mt-4 flex flex-wrap items-center gap-3">
				<UiButton v-if="retained.canReattach" variant="secondary" size="sm" @click="goConnect">
					{{ t('components.postbox.postboxConnectedAccountCard.reconnect') }}
				</UiButton>
				<UiButton
					variant="ghost"
					size="sm"
					class="text-error"
					data-testid="connected-account-delete"
					@click="confirming = 'delete'"
				>
					{{ t('components.postbox.postboxConnectedAccountCard.deleteRetained') }}
				</UiButton>
			</div>
		</div>

		<!-- Nothing connected. -->
		<div v-else class="p-5">
			<p class="text-sm text-text-secondary">
				{{ t('components.postbox.postboxConnectedAccountCard.emptyBody') }}
			</p>
			<UiButton variant="secondary" size="sm" class="mt-4" @click="goConnect">
				{{ t('components.postbox.postboxConnectedAccountCard.connectCta') }}
			</UiButton>
		</div>

		<UiConfirmationDialog
			:open="confirming === 'disconnect'"
			:title="t('components.postbox.postboxConnectedAccountCard.disconnectDialogTitle')"
			:description="
				isImporting
					? t('components.postbox.postboxConnectedAccountCard.disconnectDialogImporting')
					: t('components.postbox.postboxConnectedAccountCard.disconnectDialogDescription')
			"
			:confirm-text="t('components.postbox.postboxConnectedAccountCard.disconnect')"
			variant="warning"
			:is-loading="disconnectOp.isLoading.value"
			@confirm="confirmDisconnect"
			@cancel="confirming = null"
			@update:open="confirming = $event ? 'disconnect' : null"
		/>

		<UiConfirmationDialog
			:open="confirming === 'delete'"
			:title="t('components.postbox.postboxConnectedAccountCard.deleteDialogTitle')"
			:description="
				account
					? t('components.postbox.postboxConnectedAccountCard.deleteDialogDescription')
					: t('components.postbox.postboxConnectedAccountCard.deleteRetainedDialogDescription')
			"
			:confirm-text="t('components.postbox.postboxConnectedAccountCard.deleteConfirm')"
			variant="danger"
			:is-loading="deleteOp.isLoading.value"
			@confirm="confirmDelete"
			@cancel="confirming = null"
			@update:open="confirming = $event ? 'delete' : null"
		/>
	</section>
</template>
