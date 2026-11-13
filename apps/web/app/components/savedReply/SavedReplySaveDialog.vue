<script setup lang="ts">
/**
 * "Save as reply": keeps what is in the composer, or the passage selected in
 * it or in a message, as a new saved reply. The name is required; the shortcut is what `;` finds it by. Admins choose
 * whether it is theirs or the team's; everyone else saves a personal reply.
 * Variables (`{{contact.firstName}}`) and gaps (`[[order number]]`) in the
 * text are kept as written and resolve on every later insert.
 *
 * A pasted image is left out, and the dialog says so: its bytes are a
 * part of this draft, which a saved reply has nowhere to keep, so it would be
 * inserted as an empty image.
 */
import { htmlToPlainText } from '@owlat/shared/html';
import { stripInlineImages } from '@owlat/shared/inlineImages';
import { useCreateSavedReply, type SavedReplyScope } from '~/composables/useSavedReplies';
import { ImageOffIcon } from '@coolicons/vue';
import UiSelectableListItem from '@owlat/ui/components/ui/SelectableListItem.vue';

const props = defineProps<{
	/** The text to save, as the composer's HTML (no quote, no signature). */
	bodyHtml: string;
	/** The text is a selection, which the title says. */
	fromSelection?: boolean;
}>();

const open = defineModel<boolean>('open', { required: true });

const { t } = useI18n();
const { isAdmin } = usePermissions();
const create = useCreateSavedReply();

const name = ref('');
const shortcut = ref('');
const scope = ref<SavedReplyScope>('personal');
const saving = ref(false);

const kept = computed(() => stripInlineImages(props.bodyHtml));
const preview = computed(() => htmlToPlainText(kept.value.html, { preserveBreaks: true }).trim());

async function save() {
	if (!name.value.trim() || !preview.value || saving.value) return;
	saving.value = true;
	try {
		const saved = await create(scope.value, {
			name: name.value,
			shortcut: shortcut.value,
			bodyHtml: kept.value.html,
		});
		if (saved.ok) open.value = false;
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<UiModal
		v-model:open="open"
		size="md"
		:title="
			fromSelection
				? t('shared.savedReplies.saveDialog.selectionTitle')
				: t('shared.savedReplies.saveDialog.title')
		"
	>
		<form
			id="saved-reply-save-form"
			class="space-y-3"
			data-testid="saved-reply-save-dialog"
			@submit.prevent="save"
		>
			<label class="block">
				<span class="label">
					{{ t('shared.savedReplies.fields.name') }}
				</span>
				<input
					v-model="name"
					type="text"
					class="input w-full"
					maxlength="200"
					autofocus
					:placeholder="t('shared.savedReplies.fields.namePlaceholder')"
				/>
			</label>
			<label class="block">
				<span class="label">
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
			<fieldset v-if="isAdmin" class="space-y-2">
				<legend class="label">
					{{ t('shared.savedReplies.fields.scope') }}
				</legend>
				<UiSelectableListItem
					:model-value="scope"
					type="radio"
					name="saved-reply-scope"
					value="personal"
					:label="t('shared.savedReplies.scopes.personal')"
					@update:model-value="scope = 'personal'"
				/>
				<UiSelectableListItem
					:model-value="scope"
					type="radio"
					name="saved-reply-scope"
					value="shared"
					:label="t('shared.savedReplies.scopes.shared')"
					@update:model-value="scope = 'shared'"
				/>
			</fieldset>
			<div>
				<p class="label">{{ t('shared.savedReplies.fields.text') }}</p>
				<p
					class="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border-subtle bg-bg-surface p-3 text-sm text-text-primary"
				>
					{{ preview || t('shared.savedReplies.saveDialog.emptyText') }}
				</p>
				<p
					v-if="kept.removed > 0"
					class="mt-2 flex items-start gap-1.5 text-xs text-text-secondary"
					data-testid="saved-reply-images-left-out"
				>
					<ImageOffIcon class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
					{{ t('shared.savedReplies.saveDialog.imagesLeftOut', kept.removed) }}
				</p>
			</div>
		</form>
		<!-- In the footer, so Save stays in view when a long preview scrolls the body. -->
		<template #footer>
			<UiButton variant="ghost" type="button" :disabled="saving" @click="open = false">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton
				type="submit"
				form="saved-reply-save-form"
				:disabled="!name.trim() || !preview"
				:loading="saving"
			>
				{{ t('shared.savedReplies.saveDialog.save') }}
			</UiButton>
		</template>
	</UiModal>
</template>
