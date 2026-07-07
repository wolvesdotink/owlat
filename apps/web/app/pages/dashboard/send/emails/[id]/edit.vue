<script setup lang="ts">
import {
	EmailBuilder,
	UnsavedChangesDialog,
	useFocusMode,
	type Variable,
} from '@owlat/email-builder';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Edit Email — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const route = useRoute();
const router = useRouter();
const templateId = route.params['id'] as Id<'emailTemplates'>;
const { hasActiveOrganization } = useOrganizationContext();
const { isFocusMode } = useFocusMode();

// Fetch template data
const { data: template, isLoading: templateLoading } = useConvexQuery(
	api.emailTemplates.emails.get,
	() => ({ templateId })
);

// Mutations
const { run: updateTemplate } = useBackendOperation(api.emailTemplates.emails.update, {
	label: 'Save email',
});

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

// Email editor bridge — owns the handler set, the load→dirty→save loop, and the
// media-picker / test-email plumbing. The template editor supplies only its own
// parse + publishable save.
const {
	blocks,
	subject,
	name,
	isSaving,
	hasChanges,
	showUnsavedChangesDialog,
	confirmDiscard,
	confirmSave,
	cancelNavigation,
	showMediaPicker,
	onMediaPickerSelect: handleMediaPickerSelect,
	showTestEmailModal,
	testEmailHtml,
	onSendTest: handleSendTest,
	save: handleSave,
} = useEmailEditorBridge({
	source: template,
	initialize: (t, ctx) => {
		ctx.name.value = t.name;
		ctx.subject.value = t.subject;
		try {
			const parsed = JSON.parse(t.content || '[]');
			if (Array.isArray(parsed)) {
				ctx.blocks.value = parsed;
			}
		} catch {
			ctx.blocks.value = [];
		}
	},
	save: async (ctx) => {
		await publishableEmailSave({
			identifier: { emailType: 'marketing', emailId: templateId },
			blocks: ctx.blocks.value,
			renderOptions: { theme: emailTheme.value, variableType: 'personalization' },
			supportedLanguages: template.value?.supportedLanguages ?? [],
			defaultLanguage: template.value?.defaultLanguage ?? 'en',
			update: async (payload) => {
				// The bridge clears the dirty flag only when save() resolves. The
				// operation module has toasted any categorized failure; throw so the
				// editor stays dirty instead of being marked clean on a failed save.
				const result = await updateTemplate({
					templateId,
					name: ctx.name.value,
					subject: ctx.subject.value,
					content: JSON.stringify(ctx.blocks.value),
					htmlContent: payload.htmlContent,
					htmlTranslations: payload.htmlTranslations,
					linkedBlockIds: payload.linkedBlockIds,
				});
				if (result === undefined) throw new Error('Save failed');
			},
		});
	},
});

// Back handler
const handleBack = () => {
	router.push('/dashboard/send/marketing');
};

// Settings handler
const handleSettings = () => {
	router.push(`/dashboard/send/emails/${templateId}/settings`);
};

// Translations handler
const handleTranslations = () => {
	router.push(`/dashboard/send/emails/${templateId}/translations`);
};
</script>

<template>
	<div :class="isFocusMode ? 'h-screen' : 'h-[calc(100vh-64px)]'">
		<!-- Loading State -->
		<div v-if="templateLoading" class="h-full flex items-center justify-center bg-bg-deep">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading template...</p>
			</div>
		</div>

		<!-- Not Found State -->
		<div v-else-if="!template" class="h-full flex items-center justify-center bg-bg-deep">
			<div class="text-center">
				<div class="w-12 h-12 text-error mx-auto mb-4">!</div>
				<h2 class="text-xl font-semibold text-text-primary mb-2">Template not found</h2>
				<p class="text-text-secondary mb-6">
					This email template doesn't exist or has been deleted.
				</p>
				<button class="btn btn-primary" @click="handleBack">Back to Emails</button>
			</div>
		</div>

		<!-- Email Builder -->
		<UiErrorBoundary
			v-else
			fallback-message="The email editor hit an unexpected error. Please refresh — your last saved version is safe."
		>
			<EmailBuilder
				v-model:blocks="blocks"
				v-model:subject="subject"
				v-model:name="name"
				:variables="variables"
				:config="{
					variableType: 'personalization',
					theme: emailTheme,
					showMandatoryUnsubscribeFooter: true,
					showSettings: true,
				}"
				:is-saving="isSaving"
				@save="handleSave"
				@back="handleBack"
				@settings="handleSettings"
				@send-test="handleSendTest"
			>
				<!-- Toolbar actions -->
				<template #toolbar-actions>
					<ShareLinksPopover :email-template-id="templateId" :has-unsaved-changes="hasChanges" />
					<UiButton
						variant="outline"
						size="sm"
						title="Manage translations"
						@click="handleTranslations"
					>
						<template #iconLeft>
							<Icon name="lucide:languages" class="w-4 h-4" />
						</template>
						Translations
					</UiButton>
				</template>
			</EmailBuilder>
		</UiErrorBoundary>

		<!-- Media Picker Modal -->
		<MediaPickerModal
			:open="showMediaPicker"
			@update:open="showMediaPicker = $event"
			@select="handleMediaPickerSelect"
		/>

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
			:subject="subject"
			:template-id="templateId"
			:variables="variables"
		/>
	</div>
</template>
