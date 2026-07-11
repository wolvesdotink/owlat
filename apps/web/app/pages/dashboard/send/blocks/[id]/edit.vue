<script setup lang="ts">
import {
	EmailBuilder,
	UnsavedChangesDialog,
	useFocusMode,
	type Variable,
	type EmailBuilderConfig,
} from '@owlat/email-builder';
import { api } from '@owlat/api';
useHead({ title: 'Edit Email Block — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();
const blockId = useRouteId<'emailBlocks'>();
const { hasActiveOrganization } = useOrganizationContext();
const { showToast } = useToast();
const { isFocusMode } = useFocusMode();

// Fetch block data
const { data: block, isLoading: blockLoading } = useConvexQuery(api.emailBlocks.blocks.get, () => ({
	blockId: blockId.value,
}));

// Mutations
const { run: updateBlock } = useBackendOperation(api.emailBlocks.blocks.update, {
	label: 'Save block',
});

// Fetch organization settings for email theme
// Organization email theme (incl. baseWidth) from the shared source.
const { emailTheme } = useEmailTheme();

// Fetch contact properties for personalization variables
const { data: contactProperties } = useOrganizationQuery(
	api.contacts.properties.listByOrganization
);

// Built-in contact variables (always available)
const builtInVariables: Variable[] = [
	{ key: 'email', label: 'Email', isBuiltIn: true },
	{ key: 'firstName', label: 'First Name', isBuiltIn: true },
	{ key: 'lastName', label: 'Last Name', isBuiltIn: true },
];

// Combine built-in and custom contact properties
const variables = computed<Variable[]>(() => {
	const customVars: Variable[] = (contactProperties.value || [])
		.filter((prop) => !['first_name', 'last_name'].includes(prop.key))
		.map((prop) => ({
			key: prop.key,
			label: prop.label,
			isBuiltIn: false,
		}));

	return [...builtInVariables, ...customVars];
});

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
	confirmDiscard,
	confirmSave,
	cancelNavigation,
	showMediaPicker,
	onMediaPickerSelect: handleMediaPickerSelect,
	showTestEmailModal,
	testEmailHtml,
	onSendTest: handleSendTest,
	save,
} = useEmailEditorBridge({
	source: block,
	extraWatch: [() => description.value],
	initialize: (b, ctx) => {
		ctx.name.value = b.name;
		description.value = b.description || '';
		ctx.subject.value = ''; // Blocks don't have subjects
		try {
			const parsed = JSON.parse(b.content || '[]');
			// Handle multi-block format
			if (parsed && parsed.blocks && Array.isArray(parsed.blocks)) {
				ctx.blocks.value = parsed.blocks;
			} else if (Array.isArray(parsed)) {
				ctx.blocks.value = parsed;
			} else if (parsed && parsed.type && parsed.content) {
				// Single block legacy format
				ctx.blocks.value = [
					{
						id: `block_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
						type: parsed.type,
						content: parsed.content,
					},
				];
			} else {
				ctx.blocks.value = [];
			}
		} catch {
			ctx.blocks.value = [];
		}
	},
	save: async (ctx) => {
		if (ctx.blocks.value.length === 0) {
			showToast('Add at least one block before saving', 'error');
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
		if (result === undefined) throw new Error('Save failed');
		showToast('Block saved successfully');
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
	<div :class="isFocusMode ? 'h-screen' : 'h-[calc(100vh-64px)]'">
		<!-- Loading State -->
		<div v-if="blockLoading" class="h-full flex items-center justify-center bg-bg-deep">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading block...</p>
			</div>
		</div>

		<!-- Not Found State -->
		<div v-else-if="!block" class="h-full flex items-center justify-center bg-bg-deep">
			<div class="text-center">
				<Icon name="lucide:alert-circle" class="w-12 h-12 text-error mx-auto mb-4" />
				<h2 class="text-xl font-semibold text-text-primary mb-2">Block not found</h2>
				<p class="text-text-secondary mb-6">This saved block doesn't exist or has been deleted.</p>
				<button class="btn btn-primary" @click="handleBack">Back to Blocks</button>
			</div>
		</div>

		<!-- Email Builder (Full TipTap Editor with Slash Commands) -->
		<EmailBuilder
			v-else
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
		<UiModal v-model:open="showSettingsModal" title="Block Settings" size="md">
			<div class="space-y-4">
				<!-- Name Field -->
				<UiInput v-model="name" label="Name" placeholder="Block name" required />

				<!-- Description Field -->
				<UiTextarea
					v-model="description"
					label="Description"
					placeholder="Brief description of the block..."
					:rows="2"
				/>
			</div>

			<template #footer>
				<UiButton variant="secondary" @click="showSettingsModal = false">Cancel</UiButton>
				<UiButton variant="primary" @click="showSettingsModal = false">Done</UiButton>
			</template>
		</UiModal>

		<!-- Unsaved Changes Dialog -->
		<UnsavedChangesDialog
			:show="showUnsavedChangesDialog"
			@close="cancelNavigation"
			@discard="confirmDiscard"
			@save="confirmSave"
		/>

		<!-- Send Test Email Modal -->
		<LazySendTestEmailModal
			v-if="hasActiveOrganization"
			v-model:open="showTestEmailModal"
			:html="testEmailHtml"
			:subject="name || 'Block Preview'"
			:variables="variables"
		/>
	</div>
</template>
