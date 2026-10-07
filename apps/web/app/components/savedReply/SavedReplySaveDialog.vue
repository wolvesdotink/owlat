<script setup lang="ts">
/**
 * "Save as reply": keeps what is in the composer as a new saved reply. The
 * name is required; the shortcut is what `;` finds it by. Admins choose
 * whether it is theirs or the team's; everyone else saves a personal reply.
 * Variables (`{{contact.firstName}}`) and gaps (`[[order number]]`) in the
 * text are kept as written and resolve on every later insert.
 *
 * A pasted image is left out, and the dialog says so (#1293): its bytes are a
 * part of this draft, which a saved reply has nowhere to keep, so it would be
 * inserted as an empty image.
 */
import { htmlToPlainText } from '@owlat/shared/html';
import { stripInlineImages } from '@owlat/shared/inlineImages';
import { useCreateSavedReply, type SavedReplyScope } from '~/composables/useSavedReplies';

const props = defineProps<{
	/** The text to save, as the composer's HTML (no quote, no signature). */
	bodyHtml: string;
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
	<UiModal v-model:open="open" size="md" :title="t('shared.savedReplies.saveDialog.title')">
		<form class="space-y-3" data-testid="saved-reply-save-dialog" @submit.prevent="save">
			<label class="block">
				<span class="mb-1 block text-sm text-text-secondary">
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
			<fieldset v-if="isAdmin" class="space-y-1">
				<legend class="mb-1 text-sm text-text-secondary">
					{{ t('shared.savedReplies.fields.scope') }}
				</legend>
				<label class="flex items-center gap-2 text-sm">
					<input v-model="scope" type="radio" value="personal" />
					{{ t('shared.savedReplies.scopes.personal') }}
				</label>
				<label class="flex items-center gap-2 text-sm">
					<input v-model="scope" type="radio" value="shared" />
					{{ t('shared.savedReplies.scopes.shared') }}
				</label>
			</fieldset>
			<div>
				<p class="mb-1 text-sm text-text-secondary">{{ t('shared.savedReplies.fields.text') }}</p>
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
					<Icon name="lucide:image-off" class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
					{{ t('shared.savedReplies.saveDialog.imagesLeftOut', kept.removed) }}
				</p>
			</div>
			<div class="flex items-center justify-end gap-2">
				<UiButton variant="ghost" type="button" @click="open = false">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton type="submit" :disabled="!name.trim() || !preview || saving">
					{{ t('shared.savedReplies.saveDialog.save') }}
				</UiButton>
			</div>
		</form>
	</UiModal>
</template>
