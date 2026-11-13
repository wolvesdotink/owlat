<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { DEFAULT_LABEL_COLOR, LABEL_PRESET_COLORS } from '~/utils/labelPalette';

/**
 * "Manage folders & labels" — the one CRUD surface behind the Postbox rail.
 *
 * Folder and label CRUD both live here, not as hover glyphs on the rail's rows
 * or buttons in its Labels header: setup-time verbs do not earn permanent
 * chrome in a navigation column, so the rail stays pure navigation. Reached from the rail's "More" group and from a right-click on
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

const PRESET_COLORS = LABEL_PRESET_COLORS;
// Swatches are named by their token ("Terracotta"), never by the stored hex.
const colorName = (token: string) =>
	t(
		`components.postbox.postboxLabelManager.colors.${token.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}`
	);

// The name stays in the field when the save fails, so it can be retried.
const creating = ref(false);
async function handleCreate() {
	const trimmed = newName.value.trim();
	if (!trimmed || creating.value) return;
	creating.value = true;
	try {
		const outcome = await create(trimmed, newColor.value);
		if (outcome?.ok) newName.value = '';
	} finally {
		creating.value = false;
	}
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

			<!-- Wraps: the palette, the name and Add do not fit one phone-width row. -->
			<form class="flex flex-wrap items-center gap-2 mb-1" @submit.prevent="handleCreate">
				<div class="flex items-center gap-1">
					<UiTooltip
						v-for="color in PRESET_COLORS"
						:key="color.hex"
						:text="
							t('components.postbox.postboxLabelManager.setColor', {
								color: colorName(color.token),
							})
						"
					>
						<button
							type="button"
							class="w-5 h-5 rounded-full border-2 pointer-coarse:w-8 pointer-coarse:h-8"
							:class="newColor === color.hex ? 'border-text-primary' : 'border-transparent'"
							:style="{ backgroundColor: color.hex }"
							:aria-pressed="newColor === color.hex"
							:aria-label="
								t('components.postbox.postboxLabelManager.setColor', {
									color: colorName(color.token),
								})
							"
							@click="newColor = color.hex"
						/>
					</UiTooltip>
				</div>
				<input
					ref="newInput"
					v-model="newName"
					type="text"
					:placeholder="t('components.postbox.postboxLabelManager.newNamePlaceholder')"
					:aria-label="t('components.postbox.postboxLabelManager.newNamePlaceholder')"
					class="input flex-1 min-w-0 basis-48"
				/>
				<UiButton type="submit" :disabled="!newName.trim()" :loading="creating">{{
					t('common.add')
				}}</UiButton>
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
