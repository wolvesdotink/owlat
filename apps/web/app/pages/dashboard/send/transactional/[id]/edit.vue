<script setup lang="ts">
import {
	EmailBuilder,
	UnsavedChangesDialog,
	useFocusMode,
	type Variable,
} from '@owlat/email-builder';
import { api } from '@owlat/api';
import type { StoredAttachment } from '~/components/AttachmentPanel.vue';

useHead({ title: 'Edit Transactional Email — Owlat' });

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

// Fetch transactional email data
const {
	data: email,
	isLoading: emailLoading,
	error: emailError,
	refetch: refetchEmail,
} = useConvexQuery(api.transactional.emails.get, () => ({ id: emailId.value }));

// Mutations
const { run: updateEmail } = useBackendOperation(api.transactional.emails.update, {
	label: 'Save email',
});
const { run: publishEmail } = useBackendOperation(api.transactional.emails.publish, {
	label: 'Publish email',
});
const { run: unpublishEmail } = useBackendOperation(api.transactional.emails.unpublish, {
	label: 'Unpublish email',
});
const { run: updateSchema } = useBackendOperation(api.transactional.emails.updateSchema, {
	label: 'Save variable',
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
		group: 'Data Variables',
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
	save: handleSave,
} = useEmailEditorBridge({
	source: email,
	extraWatch: [() => attachments.value, () => showUnsubscribe.value],
	initialize: (e, ctx) => {
		ctx.name.value = e.name;
		ctx.subject.value = e.subject;
		showUnsubscribe.value = e.showUnsubscribe ?? false;
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
	save: async (ctx) => {
		await publishableEmailSave({
			identifier: { emailType: 'transactional', emailId: emailId.value },
			blocks: ctx.blocks.value,
			renderOptions: { theme: emailTheme.value, variableType: 'data' },
			supportedLanguages: email.value?.supportedLanguages ?? [],
			defaultLanguage: email.value?.defaultLanguage ?? 'en',
			update: async (payload) => {
				// The bridge clears the dirty flag only when save() resolves. The
				// operation module has toasted any categorized failure; throw so the
				// editor stays dirty instead of being marked clean on a failed save.
				const result = await updateEmail({
					id: emailId.value,
					name: ctx.name.value,
					subject: ctx.subject.value,
					content: JSON.stringify(ctx.blocks.value),
					htmlContent: payload.htmlContent,
					htmlTranslations: payload.htmlTranslations,
					linkedBlockIds: payload.linkedBlockIds,
					attachments: JSON.stringify(attachments.value),
					showUnsubscribe: showUnsubscribe.value,
				});
				if (result === undefined) throw new Error('Save failed');
			},
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

	isPublishing.value = true;
	try {
		if (email.value.status === 'published') {
			await unpublishEmail({ id: emailId.value });
		} else {
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

			await publishEmail({ id: emailId.value, htmlContent, htmlTranslations });
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
		showToast(
			'Variable names must start with a letter and use letters, numbers, or underscores.',
			'error'
		);
		return;
	}

	if (dataVariables.value.some((existing) => existing.key === key)) {
		showToast('That variable already exists.', 'error');
		return;
	}

	const nextVariables = [...dataVariables.value, { key, type }];
	dataVariables.value = nextVariables;

	const result = await updateSchema({
		id: emailId.value,
		dataVariablesSchema: buildDataVariablesSchema(nextVariables),
	});
	if (result === undefined) {
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
			error-title="Couldn't load this email"
			@retry="refetchEmail"
		>
			<template #loading>
				<div class="h-full flex items-center justify-center bg-bg-deep">
					<div class="flex flex-col items-center gap-3">
						<UiSpinner />
						<p class="text-text-secondary text-sm">Loading email...</p>
					</div>
				</div>
			</template>

			<!-- Not Found State -->
			<div v-if="!email" class="h-full flex items-center justify-center bg-bg-deep">
				<div class="text-center">
					<div class="w-12 h-12 text-error mx-auto mb-4">!</div>
					<h2 class="text-xl font-semibold text-text-primary mb-2">Email not found</h2>
					<p class="text-text-secondary mb-6">
						This transactional email doesn't exist or has been deleted.
					</p>
					<button class="btn btn-primary" @click="handleBack">Back to Emails</button>
				</div>
			</div>

			<!-- Email Builder + Attachments -->
			<EmailBuilder
				v-else
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
				@save="handleSave"
				@back="handleBack"
				@send-test="handleSendTest"
				@create-variable="handleCreateVariable"
			>
				<template #toolbar-actions>
					<!-- Current lifecycle status — draft / awaiting review / published.
				     `pending_review` is shown distinctly so the author knows the
				     template is NOT sendable yet (the send API rejects it). -->
					<span
						:class="[
							'inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium',
							isPublished
								? 'bg-success/10 text-success'
								: isPendingReview
									? 'bg-warning/10 text-warning'
									: 'bg-text-tertiary/10 text-text-tertiary',
						]"
						:title="
							isPublished
								? 'This email is live and can be sent via the API.'
								: isPendingReview
									? 'This email was flagged by the content scanner and cannot be sent until an admin approves it.'
									: 'This email is a draft. Publish it to make it sendable via the API.'
						"
					>
						<Icon
							:name="
								isPublished
									? 'lucide:check-circle'
									: isPendingReview
										? 'lucide:clock-3'
										: 'lucide:pencil'
							"
							class="w-3.5 h-3.5"
						/>
						{{ isPublished ? 'Published' : isPendingReview ? 'Awaiting review' : 'Draft' }}
					</span>
					<ShareLinksPopover :transactional-email-id="emailId" :has-unsaved-changes="hasChanges" />
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
					<!-- Awaiting review — no author-side action moves this forward, so the
				     primary action is a disabled, honest state rather than "Publish". -->
					<UiButton
						v-if="isPendingReview"
						variant="secondary"
						size="sm"
						disabled
						title="Flagged by the content scanner — an admin must approve this email before it can be sent."
					>
						<template #iconLeft>
							<Icon name="lucide:clock-3" class="w-4 h-4" />
						</template>
						Awaiting review
					</UiButton>
					<!-- Publish / Unpublish — the only affordance that makes a transactional
				     email sendable; without it the send API rejects every request. -->
					<UiButton
						v-else
						:variant="isPublished ? 'secondary' : 'primary'"
						size="sm"
						:loading="isPublishing"
						:title="
							isPublished
								? 'Return this email to draft (stops new sends)'
								: 'Publish this email to make it sendable via the API'
						"
						@click="handleTogglePublish"
					>
						<template v-if="!isPublishing" #iconLeft>
							<Icon :name="isPublished ? 'lucide:rotate-ccw' : 'lucide:rocket'" class="w-4 h-4" />
						</template>
						{{ isPublished ? 'Unpublish' : 'Publish' }}
					</UiButton>
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
							<p class="text-sm font-medium text-text-primary">Awaiting review</p>
							<p class="text-sm text-text-secondary mt-1">
								This email was flagged by our content scanner and is pending review by a platform
								administrator. It is not published and the send API will reject requests for it
								until it has been approved. Edit the content and publish again to re-run the scan.
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
							<p class="text-base font-medium text-text-primary">Show unsubscribe link</p>
							<p class="text-sm text-text-tertiary mt-0.5">
								Append a Manage Preferences and Unsubscribe footer to every send of this email.
								Leave off for receipts, password resets, and other mail recipients can't opt out of.
							</p>
						</div>
						<UiSwitch
							:model-value="showUnsubscribe"
							label="Show unsubscribe link"
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
