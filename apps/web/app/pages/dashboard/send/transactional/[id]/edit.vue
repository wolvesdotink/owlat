<script setup lang="ts">
import {
	EmailBuilder,
	UnsavedChangesDialog,
	useFocusMode,
	type Variable,
} from '@owlat/email-builder';
import { api } from '@owlat/api';
import type { StoredAttachment } from '~/components/AttachmentPanel.vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.send.transactional.detail.edit.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();
const emailId = useRouteId<'transactionalEmails'>();
const { hasActiveOrganization } = useOrganizationContext();
const { renderBlocksToHtml, buildHtmlTranslationsForEmail } = useEmailHtmlRendering();
const { isFocusMode } = useFocusMode();
const { emailTheme } = useEmailTheme();
const builderFits = useEmailBuilderViewport();

// Fetch transactional email data
const {
	data: email,
	isLoading: emailLoading,
	error: emailError,
	refetch: refetchEmail,
} = useConvexQuery(api.transactional.emails.get, () => ({ id: emailId.value }));

// Mutations. The save rejects on failure (StaleDraftError for a stale
// revision, which the bridge turns into the conflict dialog).
const commitEmail = useEditorSaveOperation(api.transactional.emails.update, {
	label: () => t('dashboard.send.transactional.detail.edit.operations.save'),
});
const { run: publishEmail } = useBackendOperation(api.transactional.emails.publish, {
	label: () => t('dashboard.send.transactional.detail.edit.operations.publish'),
});
const { run: unpublishEmail } = useBackendOperation(api.transactional.emails.unpublish, {
	label: () => t('dashboard.send.transactional.detail.edit.operations.unpublish'),
});
const { run: updateSchema } = useBackendOperation(api.transactional.emails.updateSchema, {
	label: () => t('dashboard.send.transactional.detail.edit.operations.saveVariable'),
});
const { showToast } = useToast();

// Data variables from schema
interface DataVariableInfo {
	key: string;
	type: 'string' | 'number' | 'boolean' | 'date';
}

const dataVariables = ref<DataVariableInfo[]>([]);
const dataVariableKeyRegex = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const buildDataVariablesSchema = (
	vars: DataVariableInfo[]
): Record<string, DataVariableInfo['type']> =>
	Object.fromEntries(vars.map((variable) => [variable.key, variable.type]));

// Initialize data variables from email schema
watch(
	email,
	(newEmail) => {
		if (newEmail && newEmail.dataVariablesSchema) {
			try {
				const rawSchema = newEmail.dataVariablesSchema;
				const schema = (
					typeof rawSchema === 'string' ? JSON.parse(rawSchema) : rawSchema
				) as Record<string, string>;
				dataVariables.value = Object.entries(schema).map(([key, type]) => ({
					key,
					type: type as DataVariableInfo['type'],
				}));
			} catch {
				dataVariables.value = [];
			}
		}
	},
	{ immediate: true }
);

// Convert data variables to unified Variable interface
const variables = computed<Variable[]>(() => {
	return dataVariables.value.map((v) => ({
		key: v.key,
		label: v.key,
		type: v.type,
		group: t('dashboard.send.transactional.detail.edit.variableGroup'),
		isBuiltIn: false,
	}));
});

// Publishing state (publish/unpublish lifecycle)
const isPublishing = ref(false);

// Lifecycle status drives the publish affordance and the review banner.
// `pending_review` is reached when the content scanner flags a publish as
// suspicious: the template is NOT sendable until an admin approves it, so the
// UI must not present it as successfully published.
type TransactionalStatus = 'draft' | 'pending_review' | 'published';
const status = computed<TransactionalStatus>(
	() => (email.value?.status as TransactionalStatus | undefined) ?? 'draft'
);
const isPublished = computed(() => status.value === 'published');
const isPendingReview = computed(() => status.value === 'pending_review');

// Attachments state
const attachments = ref<StoredAttachment[]>([]);

// Whether to append the unsubscribe + manage-preferences footer to sends of
// this transactional email. Off by default — most transactional mail (receipts,
// password resets) is exempt from unsubscribe. Persisted as `showUnsubscribe`
// and consumed at send time by the delivery worker.
const showUnsubscribe = ref(false);

// The author's manual text/plain body ('' = ship the generated one). Edited in
// the builder's Text view; dirty-tracked and saved with the rest of the email.
const plainTextOverride = ref('');

// Email editor bridge — owns the handler set, the load→dirty→save loop, and the
// media-picker / test-email plumbing. The transactional editor adds attachments
// to the dirty-tracked refs and supplies its own publishable save.
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
	source: email,
	revision: (row) => row.contentRevision ?? 0,
	extraWatch: [attachments, showUnsubscribe, plainTextOverride],
	canKeepDraft: sameDefaultLanguage,
	initialize: (e, ctx) => {
		ctx.name.value = e.name;
		ctx.subject.value = e.subject;
		showUnsubscribe.value = e.showUnsubscribe ?? false;
		plainTextOverride.value = e.plainTextOverride ?? '';
		try {
			const parsed = JSON.parse(e.content || '[]');
			if (Array.isArray(parsed)) {
				ctx.blocks.value = parsed;
			}
		} catch {
			ctx.blocks.value = [];
		}
		// Initialize attachments
		try {
			const parsedAttachments = JSON.parse(e.attachments || '[]');
			if (Array.isArray(parsedAttachments)) {
				attachments.value = parsedAttachments;
			}
		} catch {
			attachments.value = [];
		}
	},
	save: async (ctx, base) => {
		// Everything is read here, before the first await; the payload is built
		// from this snapshot and the row the draft was loaded from.
		const id = emailId.value;
		const surfaceFields = {
			attachments: JSON.stringify(attachments.value),
			showUnsubscribe: showUnsubscribe.value,
		};
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
			renderOptions: { theme: emailTheme.value, variableType: 'data' },
			commit: async (payload) =>
				(await commitEmail({ id, ...payload, ...surfaceFields })).contentRevision,
		});
	},
});

// Generate HTML from current blocks
const generateHtml = async (): Promise<string> => {
	return await renderBlocksToHtml(blocks.value, {
		variableType: 'data',
	});
};

// Publish/unpublish handler
const handleTogglePublish = async () => {
	if (!email.value) return;
	// Awaiting review is a terminal, author-side dead-end: only an admin can move
	// it forward, so there is no publish/unpublish action to take here.
	if (isPendingReview.value) return;
	// The publish HTML below is rendered from the canvas, so publishing with
	// unsaved edits would put content live that the saved email does not hold.
	// The toolbar disables Publish; this covers any other caller. Unpublish
	// stays allowed: a published email refuses saves, so unpublishing is how
	// those edits get saved at all.
	if (hasChanges.value && email.value.status !== 'published') return;

	isPublishing.value = true;
	try {
		if (email.value.status === 'published') {
			await unpublishEmail({ id: emailId.value });
		} else {
			// The revision the HTML below is rendered from, read before any await:
			// a write landing while it renders refuses the publish.
			const expectedContentRevision = email.value.contentRevision ?? 0;
			// Generate HTML content before publishing
			const htmlContent = await generateHtml();
			const supported = email.value.supportedLanguages ?? [];
			const defaultLanguage = email.value.defaultLanguage ?? 'en';
			const translationsObject = await buildHtmlTranslationsForEmail(
				{ emailType: 'transactional', emailId: emailId.value },
				supported,
				defaultLanguage,
				{ variableType: 'data' }
			);
			const htmlTranslations = JSON.stringify(translationsObject);

			await publishEmail({
				id: emailId.value,
				htmlContent,
				htmlTranslations,
				expectedContentRevision,
			});
		}
	} finally {
		isPublishing.value = false;
	}
};

// Back handler
const handleBack = () => {
	router.push('/dashboard/send/transactional');
};

// Translations handler
const handleTranslations = () => {
	router.push(`/dashboard/send/transactional/${emailId.value}/translations`);
};

const handleCreateVariable = async (variable: { key: string; type?: string }) => {
	const key = variable.key.trim();
	const type = (variable.type ?? 'string') as DataVariableInfo['type'];

	if (!dataVariableKeyRegex.test(key)) {
		showToast(t('dashboard.send.transactional.detail.edit.toasts.invalidVariableName'), 'error');
		return;
	}

	if (dataVariables.value.some((existing) => existing.key === key)) {
		showToast(t('dashboard.send.transactional.detail.edit.toasts.duplicateVariable'), 'error');
		return;
	}

	const nextVariables = [...dataVariables.value, { key, type }];
	dataVariables.value = nextVariables;

	const result = await updateSchema({
		id: emailId.value,
		dataVariablesSchema: buildDataVariablesSchema(nextVariables),
	});
	if (!result.ok) {
		// Roll back the optimistic add; the module has toasted the failure.
		dataVariables.value = dataVariables.value.filter((existing) => existing.key !== key);
		return;
	}
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
		<UiQueryBoundary
			:loading="emailLoading"
			:error="emailError"
			:error-title="t('dashboard.send.transactional.detail.edit.loadError')"
			@retry="refetchEmail"
		>
			<template #loading>
				<div class="h-full flex items-center justify-center bg-bg-deep">
					<div class="flex flex-col items-center gap-3">
						<UiSpinner />
						<p class="text-text-secondary text-sm">
							{{ t('dashboard.send.transactional.detail.edit.loading') }}
						</p>
					</div>
				</div>
			</template>

			<!-- Not Found State -->
			<div v-if="!email" class="h-full flex items-center justify-center bg-bg-deep">
				<div class="text-center">
					<div class="w-12 h-12 text-error mx-auto mb-4">!</div>
					<h2 class="text-xl font-semibold text-text-primary mb-2">
						{{ t('dashboard.send.transactional.detail.edit.notFound.title') }}
					</h2>
					<p class="text-text-secondary mb-6">
						{{ t('dashboard.send.transactional.detail.edit.notFound.description') }}
					</p>
					<UiButton @click="handleBack">{{
						t('dashboard.send.transactional.detail.edit.backToEmails')
					}}</UiButton>
				</div>
			</div>

			<!-- Too narrow for the canvas — an honest gate beats a broken editor. -->
			<EmailBuilderViewportGate v-else-if="!builderFits">
				<template #action>
					<UiButton variant="secondary" @click="handleBack">
						{{ t('dashboard.send.transactional.detail.edit.backToEmails') }}
					</UiButton>
				</template>
			</EmailBuilderViewportGate>

			<!-- Email Builder + Attachments -->
			<EmailBuilder
				v-else
				ref="builderRef"
				v-model:blocks="blocks"
				v-model:subject="subject"
				v-model:name="name"
				:variables="variables"
				:config="{
					variableType: 'data',
					blockTypes: ['text', 'image', 'button', 'divider', 'spacer', 'columns'],
					hideSubject: false,
				}"
				:is-saving="isSaving"
				:plain-text-override="plainTextOverride"
				:allow-plain-text-override="true"
				@update:plain-text-override="plainTextOverride = $event"
				@save="requestSave"
				@back="handleBack"
				@send-test="handleSendTest"
				@create-variable="handleCreateVariable"
			>
				<template #toolbar-actions>
					<TransactionalEditorToolbarActions
						:email-id="emailId"
						:is-published="isPublished"
						:is-pending-review="isPendingReview"
						:is-publishing="isPublishing"
						:has-changes="hasChanges"
						@toggle-publish="handleTogglePublish"
						@translations="handleTranslations"
					/>
				</template>
				<template #after-canvas>
					<!-- Awaiting-review banner — the content scanner flagged this email, so
				     it is NOT sendable until an admin approves it. Shown instead of
				     letting the author believe a successful publish made it live. -->
					<div
						v-if="isPendingReview"
						class="mt-3 p-4 bg-warning/10 border border-warning/20 rounded-lg flex items-start gap-3"
					>
						<Icon name="lucide:shield-alert" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
						<div>
							<p class="text-sm font-medium text-text-primary">
								{{ t('dashboard.send.transactional.detail.edit.reviewBanner.title') }}
							</p>
							<p class="text-sm text-text-secondary mt-1">
								{{ t('dashboard.send.transactional.detail.edit.reviewBanner.body') }}
							</p>
						</div>
					</div>
					<div class="mt-3 rounded-lg shadow-surface-1 bg-bg-elevated px-10 py-5">
						<AttachmentPanel
							:attachments="attachments"
							@update:attachments="attachments = $event"
						/>
					</div>
					<!-- Unsubscribe footer — when on, sends of this email append a
				     Manage Preferences / Unsubscribe footer (built per-recipient at
				     send time). Off by default: most transactional mail is exempt. -->
					<div
						class="mt-3 rounded-lg shadow-surface-1 bg-bg-elevated px-10 py-5 flex items-center justify-between gap-4"
					>
						<div>
							<p class="text-base font-medium text-text-primary">
								{{ t('dashboard.send.transactional.detail.edit.unsubscribe.title') }}
							</p>
							<p class="text-sm text-text-tertiary mt-0.5">
								{{ t('dashboard.send.transactional.detail.edit.unsubscribe.description') }}
							</p>
						</div>
						<UiSwitch
							:model-value="showUnsubscribe"
							:label="t('dashboard.send.transactional.detail.edit.unsubscribe.title')"
							class="shrink-0"
							@update:model-value="showUnsubscribe = $event"
						/>
					</div>
				</template>
			</EmailBuilder>
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
			:variables="variables"
			:data-variable-schema="dataVariables"
		/>
	</div>
</template>
