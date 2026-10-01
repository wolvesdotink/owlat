<script setup lang="ts">
import {
	EmailBuilder,
	UnsavedChangesDialog,
	useFocusMode,
	parseStoredBlocks,
	type EmailBuilderConfig,
} from '@owlat/email-builder';
import { api } from '@owlat/api';
const { t } = useI18n();

useHead({ title: () => t('dashboard.send.blocks.detail.edit.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();
const blockId = useRouteId<'emailBlocks'>();
const { hasActiveOrganization } = useOrganizationContext();
const { showToast } = useToast();
const { isFocusMode } = useFocusMode();
const builderFits = useEmailBuilderViewport();

// Fetch block data
const { data: block, isLoading: blockLoading } = useConvexQuery(api.emailBlocks.blocks.get, () => ({
	blockId: blockId.value,
}));

// Mutations
const { run: updateBlock } = useBackendOperation(api.emailBlocks.blocks.update, {
	label: () => t('dashboard.send.blocks.detail.edit.saveOperation'),
});

// Fetch organization settings for email theme
// Organization email theme (incl. baseWidth) from the shared source.
const { emailTheme } = useEmailTheme();

// Personalization variables: built-in contact fields plus custom properties.
const variables = usePersonalizationVariables();

// Page-owned editor state.
const description = ref('');
const showSettingsModal = ref(false);

// Config for email builder - customized for block editing
const builderConfig = computed<EmailBuilderConfig>(() => ({
	variableType: 'personalization',
	theme: emailTheme.value,
	// Hide subject field since blocks don't have subjects
	hideSubject: true,
	// Mode for editing saved blocks
	mode: 'block',
	// Host binds @settings and renders a Block Settings modal
	showSettings: true,
}));

// Email editor bridge — owns the handler set, the load→dirty→save loop, and the
// media-picker / test-email plumbing. The saved-block editor adds description to
// the dirty-tracked refs and serializes its own { blocks: [...] } envelope.
const {
	blocks,
	subject,
	name,
	isSaving,
	showUnsavedChangesDialog,
	isSavingBeforeLeave,
	confirmDiscard,
	confirmSave,
	cancelNavigation,
	showMediaPicker,
	onMediaPickerSelect: handleMediaPickerSelect,
	showTestEmailModal,
	testEmailHtml,
	onSendTest: handleSendTest,
	save,
	builderRef,
} = useEmailEditorBridge({
	source: block,
	extraWatch: [description],
	initialize: (b, ctx) => {
		ctx.name.value = b.name;
		description.value = b.description || '';
		ctx.subject.value = ''; // Blocks don't have subjects
		// Reads the { blocks } envelope this page writes, a bare array and the
		// legacy single-block form.
		ctx.blocks.value = parseStoredBlocks(b.content);
	},
	save: async (ctx) => {
		if (ctx.blocks.value.length === 0) {
			showToast(t('dashboard.send.blocks.detail.edit.emptyBlockError'), 'error');
			throw new Error('Cannot save an empty block');
		}
		// Save in multi-block format. The operation module toasts any categorized
		// failure; throw so the bridge keeps the editor dirty on a failed save.
		const result = await updateBlock({
			blockId: blockId.value,
			name: ctx.name.value.trim(),
			description: description.value.trim() || undefined,
			content: JSON.stringify({
				blocks: ctx.blocks.value.map((b) => ({
					id: b.id,
					type: b.type,
					content: b.content,
				})),
			}),
		});
		if (!result.ok) throw new Error('Save failed');
		showToast(t('dashboard.send.blocks.detail.edit.savedToast'));
	},
});

// Save handler — surfaces the empty-block guard and save failures via toast (the
// bridge clears dirty only when the save resolves).
const handleSave = async () => {
	try {
		await save();
	} catch {
		// The failure has already been surfaced via a toast; keep the editor dirty.
	}
};

// Back handler - route guard will handle unsaved changes warning
const handleBack = () => {
	router.push('/dashboard/send/blocks');
};

// Settings handler - opens the settings modal
const handleSettings = () => {
	showSettingsModal.value = true;
};
</script>

<template>
	<div
		:class="
			isFocusMode
				? 'h-[calc(100dvh-var(--titlebar-h,0px))]'
				: 'h-[calc(100dvh-var(--titlebar-h,0px)-64px)]'
		"
	>
		<!-- Loading State -->
		<div v-if="blockLoading" class="h-full flex items-center justify-center bg-bg-deep">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">
					{{ t('dashboard.send.blocks.detail.edit.loading') }}
				</p>
			</div>
		</div>

		<!-- Not Found State -->
		<div v-else-if="!block" class="h-full flex items-center justify-center bg-bg-deep">
			<div class="text-center">
				<Icon name="lucide:alert-circle" class="w-12 h-12 text-error mx-auto mb-4" />
				<h2 class="text-xl font-semibold text-text-primary mb-2">
					{{ t('dashboard.send.blocks.detail.edit.notFoundTitle') }}
				</h2>
				<p class="text-text-secondary mb-6">
					{{ t('dashboard.send.blocks.detail.edit.notFoundBody') }}
				</p>
				<UiButton @click="handleBack">
					{{ t('dashboard.send.blocks.detail.edit.backToBlocks') }}
				</UiButton>
			</div>
		</div>

		<!-- Too narrow for the canvas — an honest gate beats a broken editor. -->
		<EmailBuilderViewportGate v-else-if="!builderFits">
			<template #action>
				<UiButton variant="secondary" @click="handleBack">
					{{ t('dashboard.send.blocks.detail.edit.backToBlocks') }}
				</UiButton>
			</template>
		</EmailBuilderViewportGate>

		<!-- Email Builder (Full TipTap Editor with Slash Commands) -->
		<EmailBuilder
			v-else
			ref="builderRef"
			v-model:blocks="blocks"
			v-model:subject="subject"
			v-model:name="name"
			:variables="variables"
			:config="builderConfig"
			:is-saving="isSaving"
			@save="handleSave"
			@back="handleBack"
			@settings="handleSettings"
			@send-test="handleSendTest"
		/>

		<!-- Media Picker Modal -->
		<MediaPickerModal
			:open="showMediaPicker"
			@update:open="showMediaPicker = $event"
			@select="handleMediaPickerSelect"
		/>

		<!-- Block Settings Modal -->
		<UiModal
			v-model:open="showSettingsModal"
			:title="t('dashboard.send.blocks.detail.edit.settingsTitle')"
			size="md"
		>
			<div class="space-y-4">
				<!-- Name Field -->
				<UiInput
					v-model="name"
					:label="t('common.name')"
					:placeholder="t('dashboard.send.blocks.detail.edit.namePlaceholder')"
					required
				/>

				<!-- Description Field -->
				<UiTextarea
					v-model="description"
					:label="t('common.description')"
					:placeholder="t('dashboard.send.blocks.detail.edit.descriptionPlaceholder')"
					:rows="2"
				/>
			</div>

			<template #footer>
				<UiButton variant="secondary" @click="showSettingsModal = false">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton variant="primary" @click="showSettingsModal = false">
					{{ t('common.done') }}
				</UiButton>
			</template>
		</UiModal>

		<!-- Unsaved Changes Dialog -->
		<UnsavedChangesDialog
			:show="showUnsavedChangesDialog"
			:saving="isSavingBeforeLeave"
			@close="cancelNavigation"
			@discard="confirmDiscard"
			@save="confirmSave"
		/>

		<!-- Send Test Email Modal -->
		<LazySendTestEmailModal
			v-if="hasActiveOrganization"
			v-model:open="showTestEmailModal"
			:html="testEmailHtml"
			:subject="name || t('dashboard.send.blocks.detail.edit.previewSubject')"
			:variables="variables"
		/>
	</div>
</template>
