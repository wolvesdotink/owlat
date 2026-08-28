<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { PostboxAutoAdvanceMode } from '~/utils/postboxAutoAdvance';
import type { PostboxReplyDefaultMode } from '~/utils/postboxReplyDefault';
import { POSTBOX_REPLY_DEFAULT_OPTIONS } from '~/utils/postboxReplyDefault';
import type { PostboxDensity } from '~/utils/postboxDensity';
import { POSTBOX_DENSITY_OPTIONS } from '~/utils/postboxDensity';
import type { PostboxMarkReadPolicy } from '~/utils/postboxMarkReadPolicy';
import { POSTBOX_MARK_READ_POLICY_OPTIONS } from '~/utils/postboxMarkReadPolicy';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.index.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { mailboxes, isLoading } = usePostboxMailbox();
const { isEnabled } = useFeatureFlag();
const { isAdmin } = usePermissions();
const { isDesktop } = useDesktopContext();
const hasMail = computed(() => isEnabled('postbox') || isEnabled('mail.external'));

// ── Reading behavior (per-user, spans all mailboxes) ───────────────────
const {
	autoAdvance,
	setAutoAdvance,
	writingSuggestions,
	setWritingSuggestions,
	autoSummarize,
	setAutoSummarize,
	replyDefault,
	setReplyDefault,
	density,
	setDensity,
	markReadPolicy,
	setMarkReadPolicy,
	sendSound,
	setSendSound,
	isSaving: isSavingAutoAdvance,
} = usePostboxSettings();

function onAutoAdvanceChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value as PostboxAutoAdvanceMode;
	void setAutoAdvance(value);
}

function onReplyDefaultChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value as PostboxReplyDefaultMode;
	void setReplyDefault(value);
}

function onDensityChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value as PostboxDensity;
	void setDensity(value);
}

function onMarkReadPolicyChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value as PostboxMarkReadPolicy;
	void setMarkReadPolicy(value);
}

function onWritingSuggestionsChange(event: Event) {
	void setWritingSuggestions((event.target as HTMLInputElement).checked);
}

function onAutoSummarizeChange(event: Event) {
	void setAutoSummarize((event.target as HTMLInputElement).checked);
}

function onSendSoundChange(event: Event) {
	void setSendSound((event.target as HTMLInputElement).checked);
}

type MailboxRow = (typeof mailboxes.value)[number];

// ── Rename (display name) ──────────────────────────────────────────────
const renameTarget = ref<MailboxRow | null>(null);
const renameValue = ref('');
const renameError = ref<string | null>(null);
const setDisplayName = useBackendOperation(api.mail.mailbox.identity.setDisplayName, {
	label: () => t('dashboard.preferences.index.renameOperation'),
	inlineTarget: renameError,
});

function openRename(mb: MailboxRow) {
	renameTarget.value = mb;
	renameValue.value = mb.displayName ?? '';
	renameError.value = null;
}

async function handleRename() {
	if (!renameTarget.value) return;
	const res = await setDisplayName.run({
		mailboxId: renameTarget.value._id as Id<'mailboxes'>,
		displayName: renameValue.value,
	});
	if (!res.ok) return;
	renameTarget.value = null;
}

// ── Delete (admin-only soft-delete) ────────────────────────────────────
const deleteTarget = ref<MailboxRow | null>(null);
const removeMailbox = useBackendOperation(api.mail.mailbox.identity.remove, {
	label: () => t('dashboard.preferences.index.deleteOperation'),
});

async function handleDelete() {
	if (!deleteTarget.value) return;
	const res = await removeMailbox.run({
		mailboxId: deleteTarget.value._id as Id<'mailboxes'>,
	});
	if (!res.ok) return;
	deleteTarget.value = null;
}
</script>

<template>
	<div class="p-6 lg:p-8 max-w-4xl">
		<PreferencesHeader :has-mail="hasMail" />

		<PreferencesAppearance />

		<PreferencesLanguage />

		<template v-if="hasMail">
			<PreferencesMailLinks />

			<section class="card !p-0 mb-6">
				<header class="px-5 py-3 border-b border-border-subtle">
					<h2 class="font-semibold">{{ t('dashboard.preferences.index.reading') }}</h2>
				</header>
				<div class="px-5 py-4 flex items-center justify-between gap-4">
					<div class="min-w-0">
						<label for="postbox-auto-advance" class="font-medium text-sm block">
							{{ t('dashboard.preferences.index.autoAdvanceLabel') }}
						</label>
						<p class="text-xs text-text-tertiary mt-0.5">
							{{ t('dashboard.preferences.index.autoAdvanceHelp') }}
						</p>
					</div>
					<select
						id="postbox-auto-advance"
						class="input w-64 shrink-0"
						:value="autoAdvance"
						:disabled="isSavingAutoAdvance"
						@change="onAutoAdvanceChange"
					>
						<option
							v-for="option in POSTBOX_AUTO_ADVANCE_OPTIONS"
							:key="option.value"
							:value="option.value"
						>
							{{ t(option.label) }}
						</option>
					</select>
				</div>
				<div
					class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
				>
					<div class="min-w-0">
						<label for="postbox-mark-read" class="font-medium text-sm block">
							{{ t('dashboard.preferences.index.markReadLabel') }}
						</label>
						<p class="text-xs text-text-tertiary mt-0.5">
							{{ t('dashboard.preferences.index.markReadHelp') }}
						</p>
					</div>
					<select
						id="postbox-mark-read"
						class="input w-64 shrink-0"
						:value="markReadPolicy"
						:disabled="isSavingAutoAdvance"
						@change="onMarkReadPolicyChange"
					>
						<option
							v-for="option in POSTBOX_MARK_READ_POLICY_OPTIONS"
							:key="option.value"
							:value="option.value"
						>
							{{ t(option.label) }}
						</option>
					</select>
				</div>
				<div
					class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
				>
					<div class="min-w-0">
						<label for="postbox-density" class="font-medium text-sm block">
							{{ t('dashboard.preferences.index.densityLabel') }}
						</label>
						<p class="text-xs text-text-tertiary mt-0.5">
							{{ t('dashboard.preferences.index.densityHelp') }}
						</p>
					</div>
					<select
						id="postbox-density"
						class="input w-64 shrink-0"
						:value="density"
						:disabled="isSavingAutoAdvance"
						@change="onDensityChange"
					>
						<option
							v-for="option in POSTBOX_DENSITY_OPTIONS"
							:key="option.value"
							:value="option.value"
						>
							{{ t(option.label) }}
						</option>
					</select>
				</div>
				<div
					class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
				>
					<div class="min-w-0">
						<label for="postbox-reply-default" class="font-medium text-sm block">
							{{ t('dashboard.preferences.index.replyDefaultLabel') }}
						</label>
						<I18nT
							keypath="dashboard.preferences.index.replyDefaultHelp"
							tag="p"
							class="text-xs text-text-tertiary mt-0.5"
							scope="global"
						>
							<template #replyKey><kbd>r</kbd></template>
							<template #replyAllKey><kbd>a</kbd></template>
						</I18nT>
					</div>
					<select
						id="postbox-reply-default"
						class="input w-64 shrink-0"
						:value="replyDefault"
						:disabled="isSavingAutoAdvance"
						@change="onReplyDefaultChange"
					>
						<option
							v-for="option in POSTBOX_REPLY_DEFAULT_OPTIONS"
							:key="option.value"
							:value="option.value"
						>
							{{ t(option.label) }}
						</option>
					</select>
				</div>
				<div
					v-if="isEnabled('ai')"
					class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
				>
					<div class="min-w-0">
						<label for="postbox-writing-suggestions" class="font-medium text-sm block">
							{{ t('dashboard.preferences.index.writingSuggestionsLabel') }}
						</label>
						<p class="text-xs text-text-tertiary mt-0.5">
							{{ t('dashboard.preferences.index.writingSuggestionsHelp') }}
						</p>
					</div>
					<input
						id="postbox-writing-suggestions"
						type="checkbox"
						class="shrink-0 h-4 w-4"
						:checked="writingSuggestions"
						:disabled="isSavingAutoAdvance"
						@change="onWritingSuggestionsChange"
					/>
				</div>
				<div
					v-if="isEnabled('ai')"
					class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
				>
					<div class="min-w-0">
						<label for="postbox-auto-summarize" class="font-medium text-sm block">
							{{ t('dashboard.preferences.index.autoSummarizeLabel') }}
						</label>
						<p class="text-xs text-text-tertiary mt-0.5">
							{{ t('dashboard.preferences.index.autoSummarizeHelp') }}
						</p>
					</div>
					<input
						id="postbox-auto-summarize"
						type="checkbox"
						class="shrink-0 h-4 w-4"
						:checked="autoSummarize"
						:disabled="isSavingAutoAdvance"
						@change="onAutoSummarizeChange"
					/>
				</div>
				<div
					class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
				>
					<div class="min-w-0">
						<label for="postbox-send-sound" class="font-medium text-sm block">
							{{ t('dashboard.preferences.index.sendSoundLabel') }}
						</label>
						<p class="text-xs text-text-tertiary mt-0.5">
							{{ t('dashboard.preferences.index.sendSoundHelp') }}
						</p>
					</div>
					<input
						id="postbox-send-sound"
						type="checkbox"
						class="shrink-0 h-4 w-4"
						:checked="sendSound"
						:disabled="isSavingAutoAdvance"
						@change="onSendSoundChange"
					/>
				</div>
			</section>

			<!-- Is my mail arriving? The member-readable half of what the admin
		     delivery hub answers: my address's verification, my transport
		     alignment, and how my recent sends actually landed. -->
			<PostboxSendingHealthCard />

			<!-- Sending: reversible outbound-transport choice for a connected external
		     mailbox (own SMTP vs this instance). Self-hides for hosted-only users. -->
			<PostboxSendingSettings />

			<!-- Move my mailbox here: the staged full move of a connected external
		     mailbox onto a hosted one. Self-hides for hosted-only users. -->
			<PostboxMailboxMove />

			<!-- On this device: offline read cache (device-local, never synced). -->
			<PostboxOfflineSettings />

			<!-- Desktop-only: native notification behavior. -->
			<PostboxNotificationSettings v-if="isDesktop" />

			<section class="card !p-0">
				<header class="px-5 py-3 border-b border-border-subtle">
					<h2 class="font-semibold">{{ t('dashboard.preferences.index.mailboxes') }}</h2>
				</header>
				<div v-if="isLoading" class="p-8 flex justify-center">
					<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
				</div>
				<div v-else-if="mailboxes.length === 0" class="p-8 text-center text-text-secondary">
					{{ t('dashboard.preferences.index.noMailboxes') }}
				</div>
				<ul v-else class="divide-y divide-border-subtle">
					<li
						v-for="mb in mailboxes"
						:key="mb._id"
						class="px-5 py-3 flex items-center justify-between gap-3"
					>
						<div class="min-w-0">
							<p class="font-medium truncate">{{ mb.address }}</p>
							<p class="text-xs text-text-tertiary">
								{{
									t('dashboard.preferences.index.mailboxMeta', {
										displayName: mb.displayName ?? t('dashboard.preferences.index.noDisplayName'),
										megabytes: Math.round((mb.usedBytes ?? 0) / 1024 / 1024),
									})
								}}
							</p>
						</div>
						<div class="flex items-center gap-2 shrink-0">
							<span
								class="text-xs px-2 py-0.5 rounded"
								:class="
									mb.status === 'active'
										? 'bg-success-subtle text-success'
										: 'bg-bg-surface text-text-tertiary'
								"
								>{{ t(`dashboard.preferences.index.mailboxStatus.${mb.status}`) }}</span
							>
							<NuxtLink
								v-if="mb.scope === 'shared'"
								:to="`/dashboard/preferences/members/${mb._id}`"
								class="text-xs px-2 py-0.5 rounded bg-brand-subtle text-brand hover:underline"
								>{{ t('dashboard.preferences.index.teamManage') }}</NuxtLink
							>
							<button
								type="button"
								class="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface"
								:title="t('dashboard.preferences.index.renameMailbox')"
								:aria-label="t('dashboard.preferences.index.renameMailbox')"
								@click="openRename(mb)"
							>
								<Icon name="lucide:pencil" class="w-4 h-4" />
							</button>
							<button
								v-if="isAdmin"
								type="button"
								class="p-1.5 rounded text-text-tertiary hover:text-error hover:bg-error/10"
								:title="t('dashboard.preferences.index.deleteMailbox')"
								:aria-label="t('dashboard.preferences.index.deleteMailbox')"
								@click="deleteTarget = mb"
							>
								<Icon name="lucide:trash-2" class="w-4 h-4" />
							</button>
						</div>
					</li>
				</ul>
			</section>

			<!-- Rename mailbox -->
			<UiModal
				:open="!!renameTarget"
				:title="t('dashboard.preferences.index.renameMailbox')"
				size="sm"
				:persistent="setDisplayName.isLoading.value"
				:closable="!setDisplayName.isLoading.value"
				@update:open="
					(v: boolean) => {
						if (!v) renameTarget = null;
					}
				"
			>
				<form class="space-y-3" @submit.prevent="handleRename">
					<I18nT
						keypath="dashboard.preferences.index.renameIntro"
						tag="p"
						class="text-sm text-text-secondary"
						scope="global"
					>
						<template #address
							><code>{{ renameTarget?.address }}</code></template
						>
					</I18nT>
					<div>
						<label for="mb-display-name" class="text-sm font-medium block mb-1">
							{{ t('dashboard.preferences.index.displayName') }}
						</label>
						<input
							id="mb-display-name"
							v-model="renameValue"
							type="text"
							:placeholder="t('dashboard.preferences.index.displayNamePlaceholder')"
							class="input w-full"
						/>
						<p class="text-xs text-text-tertiary mt-1">
							{{ t('dashboard.preferences.index.displayNameHelp') }}
						</p>
					</div>
					<p v-if="renameError" class="text-sm text-error">{{ renameError }}</p>
				</form>
				<template #footer>
					<UiButton
						variant="secondary"
						:disabled="setDisplayName.isLoading.value"
						@click="renameTarget = null"
					>
						{{ t('common.cancel') }}
					</UiButton>
					<UiButton :loading="setDisplayName.isLoading.value" @click="handleRename">
						{{ t('common.save') }}
					</UiButton>
				</template>
			</UiModal>

			<!-- Delete mailbox -->
			<UiConfirmationDialog
				:open="!!deleteTarget"
				variant="danger"
				:title="t('dashboard.preferences.index.deleteMailbox')"
				:description="
					t('dashboard.preferences.index.deleteMailboxDescription', {
						address: deleteTarget?.address ?? '',
					})
				"
				:confirm-text="t('dashboard.preferences.index.deleteMailbox')"
				:is-loading="removeMailbox.isLoading.value"
				@update:open="
					(v: boolean) => {
						if (!v) deleteTarget = null;
					}
				"
				@confirm="handleDelete"
			/>
		</template>
	</div>
</template>
