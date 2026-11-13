<script setup lang="ts">
/**
 * My settings → Connected mailboxes → Mailboxes, with colour, mark, rename and (for
 * admins) delete and the hosted-decision opt-out. Members see
 * the mailboxes they can use (their own plus the team inboxes they belong to). Admins see every mailbox in the organization
 * from `identity.listOrgMailboxes`, so they can rename or retire a teammate's;
 * deliverability seed mailboxes stay on the seed screen. It used to sit at the
 * bottom of General, below thirty keyboard shortcuts.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	INBOX_COLOR_SLOTS,
	INBOX_MARK_ICONS,
	INBOX_SLOT_SWATCH,
	isInboxMarkIcon,
	type InboxMarkIcon,
} from '~/utils/inboxIdentity';
import { INBOX_MARK_ICON_COMPONENTS } from '~/lib/inboxMarkIcons';
import { PencilIcon, TrashIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const { t } = useI18n();
const {
	mailboxes: ownMailboxes,
	isLoading: ownLoading,
	error: ownError,
	refetch: refetchOwn,
} = usePostboxMailbox();
const { isAdmin } = usePermissions();
const {
	data: orgMailboxes,
	isLoading: orgLoading,
	error: orgError,
	refetch: refetchOrg,
} = useConvexQuery(api.mail.mailbox.identity.listOrgMailboxes, () => (isAdmin.value ? {} : 'skip'));
const mailboxes = computed(() => (isAdmin.value ? (orgMailboxes.value ?? []) : ownMailboxes.value));
const isLoading = computed(() => (isAdmin.value ? orgLoading.value : ownLoading.value));
// The read behind the list in use: a failed one is not "no mailboxes".
const listError = computed(() => (isAdmin.value ? orgError.value : ownError.value) ?? null);
function retryList() {
	if (isAdmin.value) refetchOrg();
	else refetchOwn();
}

type MailboxRow = (typeof mailboxes.value)[number];

// Members' byte counts come from their own query so the mailbox list does not
// change on every delivery; the admin list already carries live counts.
const { data: ownUsage } = useConvexQuery(api.mail.mailbox.identity.listUsage, () =>
	isAdmin.value ? 'skip' : {}
);
const usedBytesById = computed(
	() => new Map((ownUsage.value ?? []).map((row) => [row.mailboxId, row.usedBytes]))
);
function usedMegabytes(mb: MailboxRow): number {
	return Math.round((usedBytesById.value.get(mb._id) ?? mb.usedBytes ?? 0) / 1024 / 1024);
}

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

// The inbox's mark: one of the icons, one emoji, or `null` for the default
// (a connected account's provider logo, else initials on the icon rail).
const markIcon = ref<InboxMarkIcon | null>(null);
const markEmoji = ref('');
const markValue = computed<string | null>(() => markIcon.value ?? (markEmoji.value.trim() || null));

// A quick check so a typo is caught before saving; the backend has the final word.
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const markEmojiInvalid = computed(() => {
	const emoji = markEmoji.value.trim();
	if (markIcon.value !== null || emoji.length === 0) return false;
	const count = Array.from(graphemes.segment(emoji)).length;
	return count !== 1 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(emoji);
});

function pickMarkIcon(icon: InboxMarkIcon) {
	markIcon.value = icon;
	markEmoji.value = '';
}

function resetMark() {
	markIcon.value = null;
	markEmoji.value = '';
}

function onMarkEmojiInput() {
	if (markEmoji.value.trim().length > 0) markIcon.value = null;
}

function openRename(mb: MailboxRow) {
	renameTarget.value = mb;
	renameValue.value = mb.displayName ?? '';
	colorValue.value = mb.colorSlot ?? null;
	const mark = mb.mark ?? null;
	markIcon.value = mark !== null && isInboxMarkIcon(mark) ? mark : null;
	markEmoji.value = mark !== null && !isInboxMarkIcon(mark) ? mark : '';
	renameError.value = null;
}

async function handleRename() {
	if (!renameTarget.value || markEmojiInvalid.value) return;
	const mailboxId = renameTarget.value._id as Id<'mailboxes'>;
	const res = await setDisplayName.run({ mailboxId, displayName: renameValue.value });
	if (!res.ok) return;
	const colourChanged = (renameTarget.value.colorSlot ?? null) !== colorValue.value;
	const markChanged = (renameTarget.value.mark ?? null) !== markValue.value;
	if (colourChanged || markChanged) {
		const appearance = await setAppearance.run({
			mailboxId,
			...(colourChanged ? { colorSlot: colorValue.value } : {}),
			...(markChanged ? { mark: markValue.value } : {}),
		});
		if (!appearance.ok) return;
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
				<SpinnerIcon class="w-5 h-5 text-text-tertiary" />
			</div>
			<UiQueryBoundary v-else-if="listError" :error="listError" @retry="retryList" />
			<div v-else-if="mailboxes.length === 0" class="p-8 text-center text-text-secondary">
				{{ t('dashboard.preferences.index.noMailboxes') }}
			</div>
			<ul v-else class="divide-y divide-border-subtle">
				<li
					v-for="mb in mailboxes"
					:key="mb._id"
					class="px-5 py-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
				>
					<!-- Wraps the controls below the address on a phone instead of
					     truncating the address to its first letters. -->
					<div class="min-w-0 flex-[1_1_14rem]">
						<p class="flex items-center gap-2 font-medium">
							<InboxChip
								v-if="inboxById.get(mb._id)"
								:name="inboxById.get(mb._id)!.name"
								:slot="inboxById.get(mb._id)!.slot"
								:mark="inboxById.get(mb._id)!.mark"
							/>
							<span class="truncate" :title="mb.address">{{ mb.address }}</span>
						</p>
						<p class="text-xs text-text-tertiary">
							{{
								t('dashboard.preferences.index.mailboxMeta', {
									displayName: mb.displayName ?? t('dashboard.preferences.index.noDisplayName'),
									megabytes: usedMegabytes(mb),
								})
							}}
						</p>
					</div>
					<div class="flex items-center gap-1 shrink-0">
						<UiBadge pill :variant="mb.status === 'active' ? 'success' : 'neutral'">{{
							t(`dashboard.preferences.index.mailboxStatus.${mb.status}`)
						}}</UiBadge>
						<UiButton
							v-if="mb.scope === 'shared'"
							variant="ghost"
							size="sm"
							:to="`/dashboard/preferences/members/${mb._id}`"
							>{{ t('dashboard.preferences.index.teamManage') }}</UiButton
						>
						<UiTooltip :text="t('dashboard.preferences.index.renameMailbox')">
							<UiButton
								variant="ghost"
								size="sm"
								:aria-label="`${t('dashboard.preferences.index.renameMailbox')}: ${mb.address}`"
								@click="openRename(mb)"
							>
								<PencilIcon class="w-4 h-4" />
							</UiButton>
						</UiTooltip>
						<UiTooltip v-if="isAdmin" :text="t('dashboard.preferences.index.deleteMailbox')">
							<UiButton
								variant="danger-ghost"
								size="sm"
								:aria-label="`${t('dashboard.preferences.index.deleteMailbox')}: ${mb.address}`"
								@click="deleteTarget = mb"
							>
								<TrashIcon class="w-4 h-4" />
							</UiButton>
						</UiTooltip>
					</div>
					<!-- Only admins reach every mailbox here, a teammate's
					     personal one included, so this is where it is excluded. -->
					<SettingsHostedDecisionExclusion
						v-if="isAdmin"
						class="basis-full"
						:target="{ kind: 'mailbox', mailboxId: mb._id as Id<'mailboxes'> }"
						:is-excluded="mb.isExcludedFromHostedDecisions === true"
						:address="mb.address"
					/>
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
					<label for="mb-display-name" class="label">
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
					<legend class="label">
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
				<fieldset>
					<legend class="label">
						{{ t('dashboard.preferences.index.mark') }}
					</legend>
					<div class="flex flex-wrap items-center gap-2">
						<button
							type="button"
							class="rounded-full border px-2.5 py-1 text-xs"
							:class="
								markValue === null
									? 'border-brand text-text-primary'
									: 'border-border-default text-text-secondary'
							"
							:aria-pressed="markValue === null"
							data-testid="mailbox-mark-default"
							@click="resetMark"
						>
							{{ t('dashboard.preferences.index.markDefault') }}
						</button>
						<UiTooltip
							v-for="icon in INBOX_MARK_ICONS"
							:key="icon"
							:text="t(`dashboard.preferences.index.markIcons.${icon}`)"
						>
							<button
								type="button"
								class="flex size-7 items-center justify-center rounded-md border text-text-secondary"
								:class="markIcon === icon ? 'border-text-primary' : 'border-transparent'"
								:aria-pressed="markIcon === icon"
								:aria-label="t(`dashboard.preferences.index.markIcons.${icon}`)"
								:data-testid="`mailbox-mark-${icon}`"
								@click="pickMarkIcon(icon)"
							>
								<component :is="INBOX_MARK_ICON_COMPONENTS[icon]" class="size-4" />
							</button>
						</UiTooltip>
					</div>
					<label for="mb-mark-emoji" class="text-xs text-text-secondary block mt-2 mb-1">
						{{ t('dashboard.preferences.index.markEmoji') }}
					</label>
					<input
						id="mb-mark-emoji"
						v-model="markEmoji"
						type="text"
						maxlength="32"
						autocomplete="off"
						:placeholder="t('dashboard.preferences.index.markEmojiPlaceholder')"
						:aria-invalid="markEmojiInvalid"
						:aria-describedby="markEmojiInvalid ? 'mb-mark-emoji-error' : undefined"
						class="input w-56"
						data-testid="mailbox-mark-emoji"
						@input="onMarkEmojiInput"
					/>
					<p v-if="markEmojiInvalid" id="mb-mark-emoji-error" class="text-xs text-error mt-1">
						{{ t('dashboard.preferences.index.markEmojiInvalid') }}
					</p>
					<p class="text-xs text-text-tertiary mt-1">
						{{ t('dashboard.preferences.index.markHelp') }}
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
				<UiButton
					:loading="setDisplayName.isLoading.value"
					:disabled="markEmojiInvalid"
					@click="handleRename"
				>
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
