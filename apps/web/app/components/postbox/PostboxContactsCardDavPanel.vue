<script setup lang="ts">
/**
 * The CardDAV address book of the current mailbox, on /dashboard/postbox/contacts:
 * connect one, see how its last sync went, sync it now, or disconnect it. The
 * sync only reads the server; what it brings in lands in this mailbox's
 * contacts, never in the audience contacts.
 */
import type { Id } from '@owlat/api/dataModel';
import { VCARD_MAX_CARDS } from '@owlat/shared/postboxVcardLimits';
import { usePostboxCardDav } from '~/composables/postbox/usePostboxCardDav';
import { LinkIcon, ReloadIcon } from '@coolicons/vue';

const props = defineProps<{
	mailboxId: Id<'mailboxes'> | null;
	/** A team inbox's book is shared by its members, which the panel says. */
	isTeamInbox: boolean;
}>();

const { t } = useI18n();
const { showToast } = useToast();
const confirm = useConfirm();
const { account, isConnecting, isSyncing, isDisconnecting, connect, syncNow, disconnect } =
	usePostboxCardDav(toRef(props, 'mailboxId'));

const isFormOpen = ref(false);
const form = ref({ serverUrl: '', username: '', password: '' });
const formError = ref<string | null>(null);
const canSubmit = computed(
	() => !!form.value.serverUrl.trim() && !!form.value.username.trim() && !!form.value.password
);

function openForm() {
	form.value = { serverUrl: '', username: '', password: '' };
	formError.value = null;
	isFormOpen.value = true;
}

async function submit() {
	if (!canSubmit.value || isConnecting.value) return;
	formError.value = null;
	const result = await connect({
		serverUrl: form.value.serverUrl.trim(),
		username: form.value.username.trim(),
		password: form.value.password,
	});
	if (result.ok) {
		isFormOpen.value = false;
		form.value.password = '';
		showToast(t('dashboard.postbox.contacts.carddav.connectedToast'), 'success');
		return;
	}
	if (result.reason)
		formError.value = t(`dashboard.postbox.contacts.carddav.errors.${result.reason}`);
}

async function runSync() {
	const result = await syncNow();
	if (result.ok && result.result.isScheduled) {
		showToast(t('dashboard.postbox.contacts.carddav.syncStarted'), 'success');
	}
}

async function runDisconnect() {
	const isConfirmed = await confirm({
		title: t('dashboard.postbox.contacts.carddav.disconnectTitle'),
		body: t('dashboard.postbox.contacts.carddav.disconnectBody'),
		confirmText: t('dashboard.postbox.contacts.carddav.disconnect'),
		variant: 'warning',
	});
	if (!isConfirmed) return;
	const result = await disconnect();
	if (result.ok) showToast(t('dashboard.postbox.contacts.carddav.disconnectedToast'), 'success');
}

function serverHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

const statusLine = computed(() => {
	const current = account.value;
	if (!current) return null;
	if (current.lastErrorCode) {
		return t('dashboard.postbox.contacts.carddav.syncFailed', {
			reason: t(`dashboard.postbox.contacts.carddav.errors.${current.lastErrorCode}`),
		});
	}
	if (current.lastSyncedAt === undefined) return t('dashboard.postbox.contacts.carddav.firstSync');
	return t('dashboard.postbox.contacts.carddav.lastSynced', {
		time: formatRelativeTime(current.lastSyncedAt),
	});
});
</script>

<template>
	<section class="mb-4 rounded-lg border border-border-subtle px-4 py-3">
		<div v-if="account" class="flex flex-wrap items-center gap-x-4 gap-y-2">
			<div class="min-w-0 flex-[1_1_16rem]">
				<p class="text-sm font-medium text-text-primary truncate">
					{{
						t('dashboard.postbox.contacts.carddav.syncing', {
							name: account.addressBookName || t('dashboard.postbox.contacts.carddav.title'),
							server: serverHost(account.serverUrl),
						})
					}}
				</p>
				<p
					class="text-xs"
					:class="account.lastErrorCode ? 'text-error' : 'text-text-tertiary'"
					role="status"
				>
					{{ statusLine }}
				</p>
				<p v-if="account.isTruncated" class="text-xs text-text-tertiary">
					{{ t('dashboard.postbox.contacts.carddav.truncated', { max: VCARD_MAX_CARDS }) }}
				</p>
				<p v-if="isTeamInbox" class="text-xs text-text-tertiary">
					{{ t('dashboard.postbox.contacts.carddav.sharedNote') }}
				</p>
			</div>
			<div class="flex items-center gap-2">
				<UiButton
					variant="secondary"
					size="sm"
					type="button"
					:loading="isSyncing"
					:disabled="isSyncing"
					@click="runSync"
				>
					<template #iconLeft><ReloadIcon class="w-4 h-4" /></template>
					{{ t('dashboard.postbox.contacts.carddav.syncNow') }}
				</UiButton>
				<UiButton
					variant="danger-ghost"
					size="sm"
					type="button"
					:loading="isDisconnecting"
					:disabled="isDisconnecting"
					@click="runDisconnect"
				>
					{{ t('dashboard.postbox.contacts.carddav.disconnect') }}
				</UiButton>
			</div>
		</div>
		<div v-else class="flex flex-wrap items-center gap-x-4 gap-y-2">
			<div class="min-w-0 flex-[1_1_16rem]">
				<p class="text-sm font-medium text-text-primary">
					{{ t('dashboard.postbox.contacts.carddav.title') }}
				</p>
				<p class="text-xs text-text-tertiary">
					{{ t('dashboard.postbox.contacts.carddav.description') }}
				</p>
			</div>
			<UiButton
				variant="secondary"
				size="sm"
				type="button"
				:disabled="!mailboxId"
				@click="openForm"
			>
				<template #iconLeft><LinkIcon class="w-4 h-4" /></template>
				{{ t('dashboard.postbox.contacts.carddav.connect') }}
			</UiButton>
		</div>

		<UiModal
			:open="isFormOpen"
			:title="t('dashboard.postbox.contacts.carddav.connect')"
			size="sm"
			@update:open="
				(open) => {
					if (!open) isFormOpen = false;
				}
			"
		>
			<form class="space-y-3" @submit.prevent="submit">
				<p class="text-xs text-text-secondary">
					{{ t('dashboard.postbox.contacts.carddav.description') }}
				</p>
				<div>
					<label for="carddav-server" class="label">
						{{ t('dashboard.postbox.contacts.carddav.serverUrl') }}
					</label>
					<input
						id="carddav-server"
						v-model="form.serverUrl"
						type="url"
						inputmode="url"
						autocomplete="url"
						required
						class="input w-full"
						:placeholder="t('dashboard.postbox.contacts.carddav.serverUrlPlaceholder')"
					/>
				</div>
				<div>
					<label for="carddav-username" class="label">
						{{ t('dashboard.postbox.contacts.carddav.username') }}
					</label>
					<input
						id="carddav-username"
						v-model="form.username"
						type="text"
						autocomplete="username"
						required
						class="input w-full"
					/>
				</div>
				<div>
					<label for="carddav-password" class="label">
						{{ t('dashboard.postbox.contacts.carddav.password') }}
					</label>
					<input
						id="carddav-password"
						v-model="form.password"
						type="password"
						autocomplete="current-password"
						required
						class="input w-full"
					/>
					<p class="text-xs text-text-tertiary mt-1">
						{{ t('dashboard.postbox.contacts.carddav.passwordHint') }}
					</p>
				</div>
				<p v-if="formError" class="text-xs text-error" role="alert">{{ formError }}</p>
				<div class="flex justify-end gap-2 pt-1">
					<UiButton variant="ghost" type="button" @click="isFormOpen = false">
						{{ t('common.cancel') }}
					</UiButton>
					<UiButton type="submit" :loading="isConnecting" :disabled="!canSubmit || isConnecting">
						{{ t('dashboard.postbox.contacts.carddav.connectAction') }}
					</UiButton>
				</div>
			</form>
		</UiModal>
	</section>
</template>
