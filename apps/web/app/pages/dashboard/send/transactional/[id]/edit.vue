<script setup lang="ts">
import {
	EmailBuilder,
	UnsavedChangesDialog,
	useFocusMode,
	parseStoredBlocks,
} from '@owlat/email-builder';
import { api } from '@owlat/api';
import { EMAIL_RENDERER_VERSION } from '@owlat/email-renderer/version';
import type { StoredAttachment } from '~/components/AttachmentPanel.vue';
import { useRecordPaletteObjectOpen } from '~/composables/useCommandPaletteObjectRecents';
import { CircleWarningIcon, ShieldWarningIcon } from '@coolicons/vue';

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
const { emailTheme, brand } = useEmailTheme();
const builderFits = useEmailBuilderViewport();

// Fetch transactional email data
const {
	data: email,
	isLoading: emailLoading,
	error: emailError,
	refetch: refetchEmail,
} = useConvexQuery(api.transactional.emails.get, () => ({ id: emailId.value }));
useRecordPaletteObjectOpen(() =>
	email.value?.name ? { kind: 'template', id: emailId.value, title: email.value.name } : null
);
useTransactionalBreadcrumbs(() => email.value?.name);

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

const testSender = useResolvedTransactionalSender(emailId);

const {
	dataVariables,
	variables,
	createVariable: handleCreateVariable,
} = useTransactionalDataVariables(emailId, email);

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

// The inbox preview line, edited under the subject. Rendered into the stored
// HTML as the hidden preheader, its tokens personalized like the subject's.
const previewText = ref('');

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
	isSavingBeforeLeave,
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
	coediting,
	isConnecting,
	onCollabFocus,
} = useEmailEditorBridge({
	source: email,
	revision: (row) => row.contentRevision ?? 0,
	extraWatch: [attachments, showUnsubscribe, plainTextOverride, previewText],
	coedit: {
		target: () => ({ type: 'transactionalEmail', id: emailId.value }),
		fields: { attachments, showUnsubscribe, plainTextOverride, previewText },
	},
	canKeepDraft: sameDefaultLanguage,
	initialize: (e, ctx) => {
		ctx.name.value = e.name;
		ctx.subject.value = e.subject;
		showUnsubscribe.value = e.showUnsubscribe ?? false;
		plainTextOverride.value = e.plainTextOverride ?? '';
		previewText.value = e.previewText ?? '';
		ctx.blocks.value = parseStoredBlocks(e.content);
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
			previewText: previewText.value,
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
				(await commitEmail({ id, ...payload, ...surfaceFields, coeditVersion: base.coeditVersion }))
					.contentRevision,
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
				rendererVersion: EMAIL_RENDERER_VERSION,
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
			:loading="emailLoading || isConnecting"
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
					<CircleWarningIcon
						class="w-12 h-12 text-error mx-auto mb-4"
						:stroke-width="1.5"
						aria-hidden="true"
					/>
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
					// The theme the server renders this email with, and the brand kit.
					theme: emailTheme,
					brand,
				}"
				:is-saving="isSaving"
				:plain-text-override="plainTextOverride"
				:allow-plain-text-override="true"
				:preview-text="previewText"
				:remote-marks="coediting?.remoteMarks.value"
				@update:plain-text-override="plainTextOverride = $event"
				@update:preview-text="previewText = $event"
				@collab-focus="onCollabFocus"
				@save="requestSave"
				@back="handleBack"
				@send-test="handleSendTest"
				@create-variable="handleCreateVariable"
			>
				<template #toolbar-actions>
					<EmailEditorPresence
						v-if="coediting"
						:people="coediting.people.value"
						:is-offline="coediting.isOffline.value"
					/>
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
						<ShieldWarningIcon class="w-5 h-5 text-warning shrink-0 mt-0.5" />
						<div>
							<p class="text-sm font-medium text-text-primary">
								{{ t('dashboard.send.transactional.detail.edit.reviewBanner.title') }}
							</p>
							<p class="text-sm text-text-secondary mt-1">
								{{ t('dashboard.send.transactional.detail.edit.reviewBanner.body') }}
							</p>
						</div>
					</div>
					<LazyTransactionalTemplateSenderCard class="mt-3" :email-id="emailId" />
					<div class="mt-3 rounded-lg shadow-surface-1 bg-bg-elevated px-10 py-5">
						<AttachmentPanel
							:attachments="attachments"
							@update:attachments="attachments = $event"
						/>
					</div>
					<TransactionalSendOptions
						v-model:show-unsubscribe="showUnsubscribe"
						:email-id="emailId"
						:variables="dataVariables"
						:optional-variables="email?.optionalDataVariables ?? []"
						:is-recipient-cap-exempt="email?.isRecipientCapExempt === true"
					/>
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
			:saving="isSavingBeforeLeave"
			@close="cancelNavigation"
			@discard="confirmDiscard"
			@save="confirmSave"
		/>

		<EmailCoeditNotices
			v-if="coediting"
			:notices="coediting.notices.value"
			@restore="coediting.restoreNotice"
			@dismiss="coediting.dismissNotice"
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
			:sender="testSender"
			:transactional-email-id="emailId"
		/>
	</div>
</template>
