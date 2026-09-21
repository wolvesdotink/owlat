<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

/**
 * "Manage folders & labels" — the one CRUD surface behind the Postbox rail.
 *
 * This used to be the label manager alone, while folder CRUD lived as hover
 * glyphs on the rail's folder rows and label CRUD as two more buttons in the
 * rail's Labels header. Setup-time verbs do not earn permanent chrome in a
 * navigation column, so both sets moved here and the rail became pure
 * navigation. Reached from the rail's "More" group and from a right-click on
 * any folder or label row.
 *
 * The dialog's open state lives in `usePostboxManageDialog` rather than in a
 * prop, because its callers are scattered across the rail (the More group, the
 * folder rows, the label tree three components down) and threading an event up
 * from each of them is how a second manage surface gets born.
 */
const props = defineProps<{ mailboxId: Id<'mailboxes'> }>();

const { t } = useI18n();

const mailboxIdRef = computed(() => props.mailboxId);
const { create } = usePostboxLabels(mailboxIdRef);
const { open, focusCreate, close } = usePostboxManageDialog();

// Label creation accepts a PATH (`Work/Clients/Acme`) — the backend creates any
// missing ancestor — so nesting is one action rather than three.
const newName = ref('');
const newColor = ref(DEFAULT_LABEL_COLOR);
const newInput = ref<HTMLInputElement | null>(null);

const PRESET_COLORS = LABEL_PRESET_HEXES;

async function handleCreate() {
	const trimmed = newName.value.trim();
	if (!trimmed) return;
	await create(trimmed, newColor.value);
	newName.value = '';
}

watch(
	focusCreate,
	async (target) => {
		if (target !== 'labels') return;
		focusCreate.value = null;
		await nextTick();
		newInput.value?.focus();
	},
	{ immediate: true }
);
</script>

<template>
	<UiModal
		:open="open"
		:title="t('components.postbox.postboxLabelManager.title')"
		size="2xl"
		@update:open="
			(v) => {
				if (!v) close();
			}
		"
	>
		<PostboxManageFolders :mailbox-id="mailboxId" />

		<div class="h-px bg-border-subtle my-5" role="separator" />

		<section>
			<h3 class="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
				{{ t('components.postbox.postboxFolderRail.labelsHeading') }}
			</h3>

			<form class="flex items-center gap-2 mb-1" @submit.prevent="handleCreate">
				<div class="flex items-center gap-1">
					<button
						v-for="color in PRESET_COLORS"
						:key="color"
						type="button"
						class="w-5 h-5 rounded-full border-2"
						:class="newColor === color ? 'border-text-primary' : 'border-transparent'"
						:style="{ backgroundColor: color }"
						:title="t('components.postbox.postboxLabelManager.setColor', { color })"
						:aria-label="t('components.postbox.postboxLabelManager.setColor', { color })"
						@click="newColor = color"
					/>
				</div>
				<input
					ref="newInput"
					v-model="newName"
					type="text"
					:placeholder="t('components.postbox.postboxLabelManager.newNamePlaceholder')"
					:aria-label="t('components.postbox.postboxLabelManager.newNamePlaceholder')"
					class="input flex-1"
				/>
				<UiButton type="submit" :disabled="!newName.trim()">{{ t('common.add') }}</UiButton>
			</form>
			<p class="text-2xs text-text-tertiary mb-3">
				{{ t('components.postbox.postboxFolderRail.labelNestingHint') }}
			</p>

			<div class="max-h-72 overflow-auto">
				<PostboxLabelTree :mailbox-id="mailboxId" manage />
			</div>
		</section>
	</UiModal>
</template>
