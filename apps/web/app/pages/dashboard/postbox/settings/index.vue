<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { PostboxAutoAdvanceMode } from '~/utils/postboxAutoAdvance';

useHead({ title: 'Postbox settings — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { mailboxes, isLoading } = usePostboxMailbox();
const { isEnabled } = useFeatureFlag();
const { isAdmin } = usePermissions();

// ── Reading behavior (per-user, spans all mailboxes) ───────────────────
const {
	autoAdvance,
	setAutoAdvance,
	writingSuggestions,
	setWritingSuggestions,
	autoSummarize,
	setAutoSummarize,
	isSaving: isSavingAutoAdvance,
} = usePostboxSettings();

function onAutoAdvanceChange(event: Event) {
	const value = (event.target as HTMLSelectElement).value as PostboxAutoAdvanceMode;
	void setAutoAdvance(value);
}

function onWritingSuggestionsChange(event: Event) {
	void setWritingSuggestions((event.target as HTMLInputElement).checked);
}

function onAutoSummarizeChange(event: Event) {
	void setAutoSummarize((event.target as HTMLInputElement).checked);
}

type MailboxRow = (typeof mailboxes.value)[number];

// ── Rename (display name) ──────────────────────────────────────────────
const renameTarget = ref<MailboxRow | null>(null);
const renameValue = ref('');
const renameError = ref<string | null>(null);
const setDisplayName = useBackendOperation(api.mail.mailbox.setDisplayName, {
	label: 'Rename mailbox',
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
	if (res === undefined) return;
	renameTarget.value = null;
}

// ── Delete (admin-only soft-delete) ────────────────────────────────────
const deleteTarget = ref<MailboxRow | null>(null);
const removeMailbox = useBackendOperation(api.mail.mailbox.remove, {
	label: 'Delete mailbox',
});

async function handleDelete() {
	if (!deleteTarget.value) return;
	const res = await removeMailbox.run({
		mailboxId: deleteTarget.value._id as Id<'mailboxes'>,
	});
	if (res === undefined) return;
	deleteTarget.value = null;
}
</script>

<template>
	<div class="p-6 lg:p-8 max-w-4xl">
		<header class="mb-6 flex items-center justify-between">
			<div>
				<h1 class="text-2xl font-semibold">Postbox settings</h1>
				<p class="text-text-secondary mt-1">Manage personal mail accounts.</p>
			</div>
			<NuxtLink to="/dashboard/postbox/settings/add-account" class="btn btn-primary">
				<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
				Add account
			</NuxtLink>
		</header>

		<nav class="grid grid-cols-2 gap-3 mb-6">
			<NuxtLink
				v-if="isEnabled('mail.external')"
				to="/dashboard/postbox/migrate"
				class="card !p-4 hover:bg-bg-surface flex items-center gap-3 border-brand/30"
			>
				<Icon name="lucide:mail" class="w-5 h-5 text-brand" />
				<div>
					<p class="font-medium text-sm">Migrate from Google</p>
					<p class="text-xs text-text-tertiary">Import your Gmail history + teach your AI</p>
				</div>
			</NuxtLink>
			<NuxtLink
				v-if="isEnabled('mail.external')"
				to="/dashboard/postbox/settings/external-account"
				class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
			>
				<Icon name="lucide:mail-plus" class="w-5 h-5 text-text-secondary" />
				<div>
					<p class="font-medium text-sm">External mailbox</p>
					<p class="text-xs text-text-tertiary">Connect Gmail / Fastmail / your server</p>
				</div>
			</NuxtLink>
			<NuxtLink
				to="/dashboard/postbox/settings/filters"
				class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
			>
				<Icon name="lucide:filter" class="w-5 h-5 text-text-secondary" />
				<div>
					<p class="font-medium text-sm">Filters</p>
					<p class="text-xs text-text-tertiary">Auto-route inbound mail</p>
				</div>
			</NuxtLink>
			<NuxtLink
				to="/dashboard/postbox/settings/aliases"
				class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
			>
				<Icon name="lucide:at-sign" class="w-5 h-5 text-text-secondary" />
				<div>
					<p class="font-medium text-sm">Aliases</p>
					<p class="text-xs text-text-tertiary">Alternate addresses</p>
				</div>
			</NuxtLink>
			<NuxtLink
				to="/dashboard/postbox/settings/forwarding"
				class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
			>
				<Icon name="lucide:forward" class="w-5 h-5 text-text-secondary" />
				<div>
					<p class="font-medium text-sm">Forwarding</p>
					<p class="text-xs text-text-tertiary">External forwarding rules</p>
				</div>
			</NuxtLink>
			<NuxtLink
				to="/dashboard/postbox/settings/vacation"
				class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
			>
				<Icon name="lucide:plane" class="w-5 h-5 text-text-secondary" />
				<div>
					<p class="font-medium text-sm">Vacation</p>
					<p class="text-xs text-text-tertiary">Auto-reply while away</p>
				</div>
			</NuxtLink>
			<NuxtLink
				to="/dashboard/postbox/settings/signatures"
				class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
			>
				<Icon name="lucide:signature" class="w-5 h-5 text-text-secondary" />
				<div>
					<p class="font-medium text-sm">Signatures</p>
					<p class="text-xs text-text-tertiary">Auto-append to new drafts</p>
				</div>
			</NuxtLink>
			<NuxtLink
				v-if="isEnabled('ai')"
				to="/dashboard/postbox/settings/writing-voice"
				class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
			>
				<Icon name="lucide:wand-sparkles" class="w-5 h-5 text-text-secondary" />
				<div>
					<p class="font-medium text-sm">Writing voice</p>
					<p class="text-xs text-text-tertiary">Make AI drafts sound like you</p>
				</div>
			</NuxtLink>
			<NuxtLink
				to="/dashboard/postbox/settings/app-passwords"
				class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
			>
				<Icon name="lucide:key-round" class="w-5 h-5 text-text-secondary" />
				<div>
					<p class="font-medium text-sm">App passwords</p>
					<p class="text-xs text-text-tertiary">For Apple Mail / Thunderbird</p>
				</div>
			</NuxtLink>
		</nav>

		<section class="card !p-0 mb-6">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">Reading</h2>
			</header>
			<div class="px-5 py-4 flex items-center justify-between gap-4">
				<div class="min-w-0">
					<label for="postbox-auto-advance" class="font-medium text-sm block">
						After archiving, deleting or snoozing
					</label>
					<p class="text-xs text-text-tertiary mt-0.5">
						What the reader shows once the open conversation is triaged away.
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
						{{ option.label }}
					</option>
				</select>
			</div>
			<div
				v-if="isEnabled('ai')"
				class="px-5 py-4 flex items-center justify-between gap-4 border-t border-border-subtle"
			>
				<div class="min-w-0">
					<label for="postbox-writing-suggestions" class="font-medium text-sm block">
						Writing suggestions
					</label>
					<p class="text-xs text-text-tertiary mt-0.5">
						Show inline AI autocomplete as you write. Press Tab to accept.
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
						Auto-summarize long threads
					</label>
					<p class="text-xs text-text-tertiary mt-0.5">
						Show a one-line AI summary at the top of long conversations. Click it to
						expand the key points.
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
		</section>

		<section class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">Mailboxes</h2>
			</header>
			<div v-if="isLoading" class="p-8 flex justify-center">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>
			<div v-else-if="mailboxes.length === 0" class="p-8 text-center text-text-secondary">
				No mailboxes yet. Add your first account to start receiving mail.
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
							{{ mb.displayName ?? '(no display name)' }}
							· {{ Math.round((mb.usedBytes ?? 0) / 1024 / 1024) }} MB used
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
						>{{ mb.status }}</span>
						<button
							type="button"
							class="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface"
							title="Rename mailbox"
							aria-label="Rename mailbox"
							@click="openRename(mb)"
						>
							<Icon name="lucide:pencil" class="w-4 h-4" />
						</button>
						<button
							v-if="isAdmin"
							type="button"
							class="p-1.5 rounded text-text-tertiary hover:text-error hover:bg-error/10"
							title="Delete mailbox"
							aria-label="Delete mailbox"
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
			title="Rename mailbox"
			size="sm"
			:persistent="setDisplayName.isLoading.value"
			:closable="!setDisplayName.isLoading.value"
			@update:open="(v: boolean) => { if (!v) renameTarget = null; }"
		>
			<form class="space-y-3" @submit.prevent="handleRename">
				<p class="text-sm text-text-secondary">
					Display name for <code>{{ renameTarget?.address }}</code>. The address itself
					can't be changed.
				</p>
				<div>
					<label for="mb-display-name" class="text-sm font-medium block mb-1">
						Display name
					</label>
					<input
						id="mb-display-name"
						v-model="renameValue"
						type="text"
						placeholder="Marcel Pfeifer"
						class="input w-full"
					/>
					<p class="text-xs text-text-tertiary mt-1">Leave blank to clear it.</p>
				</div>
				<p v-if="renameError" class="text-sm text-error">{{ renameError }}</p>
			</form>
			<template #footer>
				<UiButton
					variant="secondary"
					:disabled="setDisplayName.isLoading.value"
					@click="renameTarget = null"
				>
					Cancel
				</UiButton>
				<UiButton :loading="setDisplayName.isLoading.value" @click="handleRename">
					Save
				</UiButton>
			</template>
		</UiModal>

		<!-- Delete mailbox -->
		<UiConfirmationDialog
			:open="!!deleteTarget"
			variant="danger"
			title="Delete mailbox"
			:description="`Deleting &quot;${deleteTarget?.address ?? ''}&quot; stops it from receiving new mail. Existing messages stay on the server but the address is removed from routing.`"
			confirm-text="Delete mailbox"
			:is-loading="removeMailbox.isLoading.value"
			@update:open="(v: boolean) => { if (!v) deleteTarget = null; }"
			@confirm="handleDelete"
		/>
	</div>
</template>
