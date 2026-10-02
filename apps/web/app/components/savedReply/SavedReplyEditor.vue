<script setup lang="ts">
/**
 * The form one saved reply is written in: name, shortcut, the text (the
 * composer's own rich editor), the variables it can use, what its other
 * `{{tokens}}` mean, and, for a shared reply, the team inboxes it is limited
 * to. Emits the finished draft; the library saves it.
 */
import type { Id } from '@owlat/api/dataModel';
import type { SavedReplyDraft } from '~/composables/useSavedReplies';
import { SAVED_REPLY_VARIABLES, type SnippetVariable } from '~/utils/postboxSnippetVariables';

const props = defineProps<{
	/** The reply being edited, or null for a new one. */
	initial: SavedReplyDraft | null;
	/** Team inboxes a shared reply can be limited to; absent for a personal reply. */
	teamInboxes?: { _id: Id<'mailboxes'>; label: string }[];
	saving?: boolean;
}>();

const emit = defineEmits<{
	(e: 'save', draft: SavedReplyDraft): void;
	(e: 'cancel'): void;
}>();

const { t } = useI18n();

const name = ref(props.initial?.name ?? '');
const shortcut = ref(props.initial?.shortcut ?? '');
const bodyHtml = ref(props.initial?.bodyHtml ?? '');
const variables = ref<SnippetVariable[]>(props.initial?.variables ?? []);
const mailboxIds = ref<Id<'mailboxes'>[]>(props.initial?.mailboxIds ?? []);

// Literal tokens shown in the help; kept out of the template, whose tokenizer
// would close an interpolation on the first `}}`.
const variableTokens = SAVED_REPLY_VARIABLES.map((variable) => `{{${variable}}}`);
const gapExample = '[[order number]]';

function toggleInbox(id: Id<'mailboxes'>, on: boolean) {
	mailboxIds.value = on
		? [...mailboxIds.value, id]
		: mailboxIds.value.filter((existing) => existing !== id);
}

function save() {
	if (!name.value.trim()) return;
	emit('save', {
		name: name.value,
		shortcut: shortcut.value,
		bodyHtml: bodyHtml.value,
		variables: variables.value,
		...(props.teamInboxes ? { mailboxIds: mailboxIds.value } : {}),
	});
}
</script>

<template>
	<form class="card p-5 space-y-4" data-testid="saved-reply-editor" @submit.prevent="save">
		<div class="flex flex-col gap-3 sm:flex-row">
			<label class="flex-1">
				<span class="mb-1 block text-sm text-text-secondary">
					{{ t('shared.savedReplies.fields.name') }}
				</span>
				<input
					v-model="name"
					type="text"
					class="input w-full"
					maxlength="200"
					:placeholder="t('shared.savedReplies.fields.namePlaceholder')"
				/>
			</label>
			<label class="sm:w-48">
				<span class="mb-1 block text-sm text-text-secondary">
					{{ t('shared.savedReplies.fields.shortcut') }}
				</span>
				<input
					v-model="shortcut"
					type="text"
					class="input w-full font-mono"
					maxlength="32"
					:placeholder="t('shared.savedReplies.fields.shortcutPlaceholder')"
				/>
			</label>
		</div>
		<div>
			<span class="mb-1 block text-sm text-text-secondary">
				{{ t('shared.savedReplies.fields.text') }}
			</span>
			<PostboxBasicEditor
				v-model="bodyHtml"
				:placeholder="t('shared.savedReplies.fields.textPlaceholder')"
			/>
		</div>
		<details class="rounded border border-border-subtle p-3 text-sm">
			<summary class="cursor-pointer text-text-secondary">
				{{ t('shared.savedReplies.help.title') }}
			</summary>
			<p class="mt-2 text-xs text-text-tertiary">{{ t('shared.savedReplies.help.variables') }}</p>
			<div class="mt-2 flex flex-wrap gap-1.5">
				<code
					v-for="token in variableTokens"
					:key="token"
					class="rounded bg-bg-surface px-1.5 py-0.5 font-mono text-xs text-text-secondary"
					v-text="token"
				/>
			</div>
			<I18nT
				keypath="shared.savedReplies.help.gaps"
				tag="p"
				class="mt-2 text-xs text-text-tertiary"
				scope="global"
			>
				<template #example><code v-text="gapExample" /></template>
			</I18nT>
		</details>
		<PostboxSnippetVariableEditor v-model="variables" :body-html="bodyHtml" />
		<fieldset v-if="teamInboxes" class="space-y-1.5">
			<legend class="mb-1 text-sm text-text-secondary">
				{{ t('shared.savedReplies.fields.limit') }}
			</legend>
			<p class="text-xs text-text-tertiary">{{ t('shared.savedReplies.fields.limitHint') }}</p>
			<p v-if="teamInboxes.length === 0" class="text-xs text-text-tertiary">
				{{ t('shared.savedReplies.fields.noTeamInboxes') }}
			</p>
			<label
				v-for="inbox in teamInboxes"
				:key="inbox._id"
				class="flex items-center gap-2 text-sm text-text-primary"
			>
				<input
					type="checkbox"
					:checked="mailboxIds.includes(inbox._id)"
					@change="toggleInbox(inbox._id, ($event.target as HTMLInputElement).checked)"
				/>
				{{ inbox.label }}
			</label>
		</fieldset>
		<div class="flex items-center justify-end gap-2">
			<UiButton variant="ghost" type="button" @click="emit('cancel')">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton type="submit" :disabled="!name.trim() || saving">
				{{ initial ? t('shared.savedReplies.saveChanges') : t('common.create') }}
			</UiButton>
		</div>
	</form>
</template>
