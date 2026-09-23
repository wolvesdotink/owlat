<script setup lang="ts">
/**
 * My settings → Connected mailboxes → Mailboxes: every mailbox this person can
 * use, with its colour, rename and (for admins) delete. It used to sit at the
 * bottom of General, below thirty keyboard shortcuts.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { INBOX_COLOR_SLOTS, INBOX_SLOT_SWATCH } from '~/utils/inboxIdentity';

const { t } = useI18n();
const { mailboxes, isLoading } = usePostboxMailbox();
const { isAdmin } = usePermissions();

type MailboxRow = (typeof mailboxes.value)[number];

// ── Rename (display name) ──────────────────────────────────────────────
const renameTarget = ref<MailboxRow | null>(null);
const renameValue = ref('');
const renameError = ref<string | null>(null);
const setDisplayName = useBackendOperation(api.mail.mailbox.identity.setDisplayName, {
	label: () => t('dashboard.preferences.index.renameOperation'),
	inlineTarget: renameError,
});

// The inbox's colour — the swatch its chip wears everywhere a reply can start.
// `null` = automatic (the next free colour in order).
const { byId: inboxById } = useInboxes();
const colorValue = ref<number | null>(null);
const colorSlots = Array.from({ length: INBOX_COLOR_SLOTS }, (_, slot) => slot);
const setAppearance = useBackendOperation(api.mail.mailbox.appearance.setAppearance, {
	label: () => t('dashboard.preferences.index.renameOperation'),
	inlineTarget: renameError,
});

function openRename(mb: MailboxRow) {
	renameTarget.value = mb;
	renameValue.value = mb.displayName ?? '';
	colorValue.value = mb.colorSlot ?? null;
	renameError.value = null;
}

async function handleRename() {
	if (!renameTarget.value) return;
	const mailboxId = renameTarget.value._id as Id<'mailboxes'>;
	const res = await setDisplayName.run({ mailboxId, displayName: renameValue.value });
	if (!res.ok) return;
	if ((renameTarget.value.colorSlot ?? null) !== colorValue.value) {
		const colour = await setAppearance.run({ mailboxId, colorSlot: colorValue.value });
		if (!colour.ok) return;
	}
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
						<p class="flex items-center gap-2 font-medium">
							<InboxChip
								v-if="inboxById.get(mb._id)"
								:name="inboxById.get(mb._id)!.name"
								:slot="inboxById.get(mb._id)!.slot"
							/>
							<span class="truncate">{{ mb.address }}</span>
						</p>
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
				<fieldset>
					<legend class="text-sm font-medium mb-1">
						{{ t('dashboard.preferences.index.colour') }}
					</legend>
					<div class="flex flex-wrap items-center gap-2">
						<button
							type="button"
							class="rounded-full border px-2.5 py-1 text-xs"
							:class="
								colorValue === null
									? 'border-brand text-text-primary'
									: 'border-border-default text-text-secondary'
							"
							:aria-pressed="colorValue === null"
							@click="colorValue = null"
						>
							{{ t('dashboard.preferences.index.colourAutomatic') }}
						</button>
						<button
							v-for="slot in colorSlots"
							:key="slot"
							type="button"
							class="flex size-7 items-center justify-center rounded-md border"
							:class="colorValue === slot ? 'border-text-primary' : 'border-transparent'"
							:aria-pressed="colorValue === slot"
							:aria-label="t('dashboard.preferences.index.colourSlot', { n: slot + 1 })"
							@click="colorValue = slot"
						>
							<span class="size-4 rounded-[3px]" :class="INBOX_SLOT_SWATCH[slot]" />
						</button>
					</div>
					<p class="text-xs text-text-tertiary mt-1">
						{{ t('dashboard.preferences.index.colourHelp') }}
					</p>
				</fieldset>
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
	</div>
</template>
