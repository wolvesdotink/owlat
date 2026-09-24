<script setup lang="ts">
import {
	EmailBuilder,
	UnsavedChangesDialog,
	useFocusMode,
	type HistoryState,
	type Variable,
} from '@owlat/email-builder';
import { api } from '@owlat/api';

const { t } = useI18n();

useHead({ title: () => t('dashboard.send.emails.detail.edit.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();
const templateId = useRouteId<'emailTemplates'>();
const { hasActiveOrganization } = useOrganizationContext();
const { isFocusMode } = useFocusMode();
const builderFits = useEmailBuilderViewport();

// Fetch template data
const {
	data: template,
	isLoading: templateLoading,
	error: templateError,
	refetch: refetchTemplate,
} = useConvexQuery(api.emailTemplates.emails.get, () => ({ templateId: templateId.value }));

// Mutations. The save rejects on failure (StaleDraftError for a stale
// revision, which the bridge turns into the conflict dialog).
const commitTemplate = useEditorSaveOperation(api.emailTemplates.emails.update, {
	label: () => t('dashboard.send.emails.detail.edit.operations.save'),
});
const { run: publishTemplate, isLoading: isPublishing } = useBackendOperation(
	api.emailTemplates.emails.publish,
	{ label: () => t('dashboard.send.emails.detail.edit.operations.publish') }
);
const { run: unpublishTemplate, isLoading: isUnpublishing } = useBackendOperation(
	api.emailTemplates.emails.unpublish,
	{ label: () => t('dashboard.send.emails.detail.edit.operations.unpublish') }
);
const { showToast } = useToast();
const isPublished = computed(() => template.value?.status === 'published');
const isChangingPublication = computed(() => isPublishing.value || isUnpublishing.value);

// Organization email theme (incl. baseWidth) from the shared source.
const { emailTheme } = useEmailTheme();

// Fetch contact properties for personalization variables
const { data: contactProperties } = useOrganizationQuery(
	api.contacts.properties.listByOrganization
);

// Built-in contact variables (always available)
const builtInVariables = computed<Variable[]>(() => [
	{ key: 'email', label: t('common.email'), isBuiltIn: true },
	{
		key: 'firstName',
		label: t('dashboard.send.emails.detail.edit.variables.firstName'),
		isBuiltIn: true,
	},
	{
		key: 'lastName',
		label: t('dashboard.send.emails.detail.edit.variables.lastName'),
		isBuiltIn: true,
	},
]);

// Combine built-in and custom contact properties
const variables = computed<Variable[]>(() => {
	const customVars: Variable[] = (contactProperties.value || [])
		.filter((prop) => !['first_name', 'last_name'].includes(prop.key))
		.map((prop) => ({
			key: prop.key,
			label: prop.label,
			isBuiltIn: false,
		}));

	return [...builtInVariables.value, ...customVars];
});

// The author's manual text/plain body ('' = ship the generated one). Edited in
// the builder's Text view; dirty-tracked and saved with the rest of the email.
const plainTextOverride = ref('');

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
	requestSave,
	builderRef,
	conflict,
	isResolvingConflict,
	keepMyVersion,
	loadLatestVersion,
	dismissConflict,
} = useEmailEditorBridge({
	source: template,
	revision: (row) => row.contentRevision ?? 0,
	extraWatch: [plainTextOverride],
	canKeepDraft: sameDefaultLanguage,
	initialize: (t, ctx) => {
		ctx.name.value = t.name;
		ctx.subject.value = t.subject;
		plainTextOverride.value = t.plainTextOverride ?? '';
		try {
			const parsed = JSON.parse(t.content || '[]');
			if (Array.isArray(parsed)) {
				ctx.blocks.value = parsed;
			}
		} catch {
			ctx.blocks.value = [];
		}
	},
	save: async (ctx, base) => {
		// Everything is read here, before the first await; the payload is built
		// from this snapshot and the row the draft was loaded from.
		const id = templateId.value;
		return await publishableEmailSave({
			draft: {
				name: ctx.name.value,
				subject: ctx.subject.value,
				blocks: ctx.blocks.value,
				plainTextOverride: plainTextOverride.value,
			},
			base: {
				supportedLanguages: base.source?.supportedLanguages ?? [],
				defaultLanguage: base.source?.defaultLanguage ?? 'en',
				translations: base.source?.translations,
				revision: base.revision,
			},
			renderOptions: { theme: emailTheme.value, variableType: 'personalization' },
			commit: async (payload) =>
				(await commitTemplate({ templateId: id, ...payload })).contentRevision,
		});
	},
});

// Version history restore: push the snapshot through the builder's explicit
// load path. Assigning `blocks` alone is not enough — a restore keeps the block
// ids and changes only their content, which the builder's prop watcher cannot
// tell apart from the live query echoing the saved document back, so it drops
// it. `loadState` re-seeds the canvas and emits back into these refs, which
// marks the editor dirty and records the restore as one more undoable step.
// Nothing is persisted until the user saves.
const handleRestoreVersion = (state: HistoryState) => {
	blocks.value = state.blocks;
	name.value = state.name;
	subject.value = state.subject;
	builderRef.value?.loadState(state);
};

// Back handler
const handleBack = () => {
	router.push('/dashboard/send/marketing');
};

// Settings handler
const handleSettings = () => {
	router.push(`/dashboard/send/emails/${templateId.value}/settings`);
};

// Translations handler
const handleTranslations = () => {
	router.push(`/dashboard/send/emails/${templateId.value}/translations`);
};

async function handlePublicationToggle() {
	if (isPublished.value) {
		const result = await unpublishTemplate({ templateId: templateId.value });
		if (result.ok) showToast(t('dashboard.send.emails.detail.edit.toasts.unpublished'));
		return;
	}
	// Publish puts the stored HTML live, which unsaved edits are not part of.
	// The button holds Publish while dirty; this covers any other caller.
	if (hasChanges.value) return;
	const row = template.value;
	if (!row?.htmlContent) {
		showToast(t('dashboard.send.emails.detail.edit.toasts.saveBeforePublish'), 'error');
		return;
	}
	// The server publishes the row's own stored HTML, and refuses while a
	// saved-block rerender is still bringing it up to date. The revision makes
	// a write landing after this click refuse the publish instead of putting
	// a version live that this tab never showed.
	const result = await publishTemplate({
		templateId: templateId.value,
		expectedContentRevision: row.contentRevision ?? 0,
	});
	if (result.ok) showToast(t('dashboard.send.emails.detail.edit.toasts.published'));
}
</script>

<template>
	<div
		:class="
			isFocusMode
				? 'h-[calc(100dvh-var(--titlebar-h,0px))]'
				: 'h-[calc(100dvh-var(--titlebar-h,0px)-64px)]'
		"
	>
		<UiQueryBoundary
			:loading="templateLoading"
			:error="templateError"
			:error-title="t('dashboard.send.emails.detail.edit.loadError')"
			@retry="refetchTemplate"
		>
			<template #loading>
				<div class="h-full flex items-center justify-center bg-bg-deep">
					<div class="flex flex-col items-center gap-3">
						<UiSpinner />
						<p class="text-text-secondary text-sm">
							{{ t('dashboard.send.emails.detail.edit.loading') }}
						</p>
					</div>
				</div>
			</template>

			<!-- Not Found State -->
			<div v-if="!template" class="h-full flex items-center justify-center bg-bg-deep">
				<div class="text-center">
					<div class="w-12 h-12 text-error mx-auto mb-4">!</div>
					<h2 class="text-xl font-semibold text-text-primary mb-2">
						{{ t('dashboard.send.emails.detail.edit.notFound.title') }}
					</h2>
					<p class="text-text-secondary mb-6">
						{{ t('dashboard.send.emails.detail.edit.notFound.description') }}
					</p>
					<UiButton @click="handleBack">{{
						t('dashboard.send.emails.detail.edit.backToEmails')
					}}</UiButton>
				</div>
			</div>

			<!-- Too narrow for the canvas — an honest gate beats a broken editor. -->
			<EmailBuilderViewportGate v-else-if="!builderFits">
				<template #action>
					<UiButton variant="secondary" @click="handleBack">
						{{ t('dashboard.send.emails.detail.edit.backToEmails') }}
					</UiButton>
				</template>
			</EmailBuilderViewportGate>

			<!-- Email Builder -->
			<UiErrorBoundary
				v-else
				:fallback-message="t('dashboard.send.emails.detail.edit.builderError')"
			>
				<EmailBuilder
					ref="builderRef"
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
					:plain-text-override="plainTextOverride"
					:allow-plain-text-override="true"
					@update:plain-text-override="plainTextOverride = $event"
					@save="requestSave"
					@back="handleBack"
					@settings="handleSettings"
					@send-test="handleSendTest"
				>
					<!-- Toolbar actions -->
					<template #toolbar-actions>
						<EmailTemplatePublishButton
							:is-published="isPublished"
							:has-changes="hasChanges"
							:has-stored-html="Boolean(template?.htmlContent)"
							:loading="isChangingPublication"
							@toggle="handlePublicationToggle"
						/>
						<EmailTemplateHistoryPanel
							:template-id="templateId"
							:has-unsaved-changes="hasChanges"
							@restore="handleRestoreVersion"
						/>
						<ShareLinksPopover :email-template-id="templateId" :has-unsaved-changes="hasChanges" />
						<UiButton
							variant="outline"
							size="sm"
							:title="t('dashboard.send.emails.detail.edit.manageTranslations')"
							@click="handleTranslations"
						>
							<template #iconLeft>
								<Icon name="lucide:languages" class="w-4 h-4" />
							</template>
							{{ t('dashboard.send.emails.detail.edit.translations') }}
						</UiButton>
					</template>
				</EmailBuilder>
			</UiErrorBoundary>
		</UiQueryBoundary>

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

		<EmailEditorConflictDialog
			:open="conflict !== null"
			:is-resolving="isResolvingConflict"
			:must-reload="conflict?.mustReload === true"
			@keep="keepMyVersion"
			@load="loadLatestVersion"
			@close="dismissConflict"
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
