<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.index.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
});

const { mailboxes, isLoading } = usePostboxMailbox();
const { isEnabled } = useFeatureFlag();
const { isAdmin } = usePermissions();
const hasMail = computed(() => isEnabled('postbox') || isEnabled('mail.external'));

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
	<div>
		<div class="mb-6 flex items-start justify-between gap-4">
			<p class="text-text-secondary">{{ t('dashboard.preferences.index.subtitle') }}</p>
			<UiButton
				v-if="hasMail"
				class="shrink-0"
				@click="navigateTo('/dashboard/preferences/add-account')"
			>
				<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
				{{ t('dashboard.preferences.index.addAccount') }}
			</UiButton>
		</div>

		<!-- Every reachable Preferences page, from the settings registry. Not
		     gated on mail: the hand-written grid this replaced was, which left
		     aliases, vacation, snippets, writing voice and app passwords with no
		     entry point on an instance without it. -->
		<PreferencesDestinations />

		<!-- `id`s are the settings registry's own control anchors, so a palette
		     deep link ("dark mode", "auto-advance") lands on the right card. -->
		<PreferencesAppearance id="appearance" class="scroll-mt-6" />

		<PreferencesLanguage id="language" class="scroll-mt-6" />

		<template v-if="hasMail">
			<PreferencesReading id="reading" class="scroll-mt-6" />

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

			<!-- Reading protections: the senders whose remote images load without
		     asking. Self-hides until the reader has granted at least one. -->
			<PostboxTrustedSendersSettings />

			<!-- Daily brief by email (idea 29): opt-in delivery of the digest that
		     until now only existed at the top of Today. -->
			<PostboxDailyBriefSettings />

			<!-- Your mail is sealed (idea 55): per-address key coverage plus the
			     recovery kit, behind a password re-prompt. Self-hides when the
			     sealedMail flag is off. -->
			<PostboxSealedMailCard />

			<!-- Files shared as links (idea 10): every link the composer handed out,
		     with an immediate revoke. Self-hides until something is shared. -->
			<PostboxSharedLinksSettings />

			<!-- Keyboard shortcuts (idea 43b): the named map this person drives the
		     app with, plus their own remaps on top. -->
			<PostboxShortcutSettings />

			<section id="mailboxes" class="card !p-0 scroll-mt-6">
				<header class="px-5 py-3 border-b border-border-subtle">
					<h2 class="font-semibold">{{ t('dashboard.preferences.index.mailboxes') }}</h2>
				</header>
				<div v-if="isLoading" class="p-8 flex justify-center">
					<Icon
						name="lucide:loader-2"
						class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary"
					/>
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
