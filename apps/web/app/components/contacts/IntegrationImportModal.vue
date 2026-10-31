<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { HandleDuplicates } from '~/composables/useCsvImport';
import IntegrationImportCompleteStep from './integrationImport/CompleteStep.vue';
import IntegrationImportConfigureStep from './integrationImport/ConfigureStep.vue';
import IntegrationImportImportingStep from './integrationImport/ImportingStep.vue';
import IntegrationImportSelectStep from './integrationImport/SelectStep.vue';

const props = defineProps<{
	topics?: Array<{ _id: string; name: string }>;
}>();

const { t } = useI18n();

const convex = useConvex();
const { showToast } = useToast();

const isOpen = defineModel<boolean>('open', { default: false });

type IntegrationImportStep = 'select' | 'configure' | 'importing' | 'complete';
type IntegrationType = 'mailchimp' | 'stripe' | 'mandrill' | null;

const step = ref<IntegrationImportStep>('select');
const selectedIntegration = ref<IntegrationType>(null);
const error = ref('');
const handleDuplicates = ref<HandleDuplicates>('skip');
const selectedTopicId = ref<string | null>(null);

const credentials = reactive({
	mailchimp: { apiKey: '', listId: '', showApiKey: false },
	stripe: { apiKey: '', showApiKey: false },
});

// Carry the audience's unsubscribed + cleaned members into the suppression list
// as well as its contacts. On by default: a migration that re-mails the people
// who opted out at Mailchimp is a compliance failure on day one, and the
// addresses are already on the wire — the contacts import fetches them and
// currently drops them.
const importSuppressions = ref(true);

// Subscribe to import progress
const { data: importProgress } = useConvexQuery(
	api.integrationImports.walker.getImportProgress,
	() => ({})
);

// Watch for import completion
watch(importProgress, (p) => {
	if (!p) return;

	if (step.value === 'importing' && p.status === 'completed') {
		step.value = 'complete';
		const name = PROVIDER_NAMES[p.provider];
		const carried = p.suppressionCounts;
		if (p.imported > 0 || p.updated > 0) {
			const totalProcessed = p.imported + p.updated;
			showToast(
				t(
					'components.contacts.integrationImportModal.toasts.processed',
					{ count: totalProcessed, provider: name },
					totalProcessed
				)
			);
		} else if (carried) {
			const suppressed =
				carried.bouncedHard +
				carried.bouncedSoft +
				carried.complained +
				carried.manual +
				carried.unsubscribed;
			showToast(
				t(
					'components.contacts.integrationImportModal.toasts.carriedOver',
					{ count: suppressed, provider: name },
					suppressed
				)
			);
		}
	}

	if (step.value === 'importing' && p.status === 'failed') {
		const lastError = p.errors[p.errors.length - 1];
		// If nothing was imported, go back to configure with the error
		if (p.imported === 0 && p.updated === 0) {
			error.value =
				lastError || t('components.contacts.integrationImportModal.errors.importFailed');
			step.value = 'configure';
		} else {
			// Partial results — show complete step with errors
			step.value = 'complete';
		}
	}
});

watch(isOpen, (newValue) => {
	if (newValue) {
		reset();
	}
});

const availableLists = computed(() => props.topics ?? []);

const reset = () => {
	step.value = 'select';
	selectedIntegration.value = null;
	error.value = '';
	credentials.mailchimp = { apiKey: '', listId: '', showApiKey: false };
	credentials.stripe = { apiKey: '', showApiKey: false };
	importSuppressions.value = true;
	handleDuplicates.value = 'skip';
	selectedTopicId.value = null;
};

const close = () => {
	isOpen.value = false;
};

const selectIntegration = (id: IntegrationType) => {
	selectedIntegration.value = id;
	step.value = 'configure';
	error.value = '';
};

const goBackToSelect = () => {
	step.value = 'select';
	error.value = '';
};

const validateConfig = (): boolean => {
	error.value = '';
	if (selectedIntegration.value === 'mailchimp') {
		if (!credentials.mailchimp.apiKey.trim()) {
			error.value = t('components.contacts.integrationImportModal.errors.mailchimpApiKeyRequired');
			return false;
		}
		if (!credentials.mailchimp.apiKey.includes('-')) {
			error.value = t('components.contacts.integrationImportModal.errors.mailchimpApiKeyFormat');
			return false;
		}
		if (!credentials.mailchimp.listId.trim()) {
			error.value = t('components.contacts.integrationImportModal.errors.audienceListIdRequired');
			return false;
		}
	} else if (selectedIntegration.value === 'stripe') {
		if (!credentials.stripe.apiKey.trim()) {
			error.value = t('components.contacts.integrationImportModal.errors.stripeApiKeyRequired');
			return false;
		}
		if (!credentials.stripe.apiKey.startsWith('sk_')) {
			error.value = t('components.contacts.integrationImportModal.errors.stripeApiKeyFormat');
			return false;
		}
	}
	return true;
};

const startImport = async () => {
	if (!validateConfig() || !convex) return;

	step.value = 'importing';
	error.value = '';

	try {
		const topicId = selectedTopicId.value || undefined;
		if (selectedIntegration.value === 'mailchimp') {
			await convex.mutation(api.integrationImports.walker.startIntegrationImport, {
				config: {
					provider: 'mailchimp',
					apiKey: credentials.mailchimp.apiKey.trim(),
					listId: credentials.mailchimp.listId.trim(),
					importSuppressions: importSuppressions.value,
				},
				handleDuplicates: handleDuplicates.value,
				topicId: topicId as Id<'topics'> | undefined,
			});
		} else if (selectedIntegration.value === 'mandrill') {
			// No credentials step: the key is `MANDRILL_API_KEY` in the backend
			// environment, the same one the send transport uses.
			await convex.mutation(api.integrationImports.walker.startIntegrationImport, {
				config: { provider: 'mandrill' },
				handleDuplicates: handleDuplicates.value,
			});
		} else if (selectedIntegration.value === 'stripe') {
			await convex.mutation(api.integrationImports.walker.startIntegrationImport, {
				config: {
					provider: 'stripe',
					apiKey: credentials.stripe.apiKey.trim(),
				},
				handleDuplicates: handleDuplicates.value,
				topicId: topicId as Id<'topics'> | undefined,
			});
		} else {
			throw new Error(t('components.contacts.integrationImportModal.errors.noIntegrationSelected'));
		}
		// Import started — progress will update via the reactive query
	} catch (err) {
		error.value =
			err instanceof Error
				? err.message
				: t('components.contacts.integrationImportModal.errors.startFailed');
		step.value = 'configure';
	}
};

const handleCancel = async () => {
	if (!convex || !importProgress.value) return;
	try {
		await convex.mutation(api.integrationImports.walker.cancelImport, {
			importId: importProgress.value._id,
		});
	} catch {
		// Ignore — import may have already completed
	}
};

const PROVIDER_NAMES: Record<'mailchimp' | 'stripe' | 'mandrill', string> = {
	mailchimp: 'Mailchimp',
	stripe: 'Stripe',
	mandrill: 'Mandrill',
};

const integrationName = computed(() =>
	selectedIntegration.value ? PROVIDER_NAMES[selectedIntegration.value] : 'Mailchimp'
);

/** Suppression-only runs have no contacts to report. */
const isSuppressionOnly = computed(() => importProgress.value?.provider === 'mandrill');
</script>

<template>
	<UiModal
		:open="isOpen"
		size="lg"
		@update:open="
			(v) => {
				if (!v) close();
			}
		"
	>
		<!-- Header -->
		<div class="flex items-center gap-3 mb-6">
			<UiIconBox icon="lucide:link-2" size="sm" variant="surface" rounded="lg" />
			<div>
				<h2 class="text-lg font-semibold text-text-primary">
					{{ t('components.contacts.integrationImportModal.title') }}
				</h2>
				<p class="text-sm text-text-tertiary">
					<template v-if="step === 'select'">{{
						t('components.contacts.integrationImportModal.steps.select')
					}}</template>
					<template v-else-if="step === 'configure'">{{
						t('components.contacts.integrationImportModal.steps.configure', {
							provider: integrationName,
						})
					}}</template>
					<template v-else-if="step === 'importing'">{{
						isSuppressionOnly
							? t('components.contacts.integrationImportModal.steps.importingSuppressions')
							: t('components.contacts.integrationImportModal.steps.importingContacts')
					}}</template>
					<template v-else-if="step === 'complete'">{{
						t('components.contacts.integrationImportModal.steps.complete')
					}}</template>
				</p>
			</div>
		</div>

		<!-- Error Alert -->
		<div
			v-if="error"
			class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20 flex items-start gap-3"
		>
			<Icon name="lucide:alert-circle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
			<p class="text-sm text-error">{{ error }}</p>
		</div>

		<!-- Step 1: Select -->
		<IntegrationImportSelectStep
			v-if="step === 'select'"
			@select="selectIntegration"
			@close="close"
		/>

		<!-- Step 2: Configure -->
		<IntegrationImportConfigureStep
			v-else-if="step === 'configure'"
			v-model:handle-duplicates="handleDuplicates"
			v-model:selected-topic-id="selectedTopicId"
			v-model:import-suppressions="importSuppressions"
			:selected-integration="selectedIntegration"
			:credentials="credentials"
			:available-lists="availableLists"
		/>

		<!-- Step 3: Importing -->
		<IntegrationImportImportingStep
			v-else-if="step === 'importing'"
			:integration-name="integrationName"
			:import-progress="importProgress"
		/>

		<!-- Step 4: Complete -->
		<IntegrationImportCompleteStep
			v-else-if="step === 'complete'"
			:import-progress="importProgress"
			:is-suppression-only="isSuppressionOnly"
		/>

		<!-- Footer -->
		<template #footer>
			<template v-if="step === 'select'">
				<UiButton variant="secondary" @click="close">{{ t('common.cancel') }}</UiButton>
			</template>
			<template v-else-if="step === 'configure'">
				<UiButton variant="secondary" @click="goBackToSelect">{{ t('common.back') }}</UiButton>
				<UiButton @click="startImport">
					<template #iconLeft><Icon name="lucide:upload" class="w-4 h-4" /></template>
					{{ t('components.contacts.integrationImportModal.footer.startImport') }}
				</UiButton>
			</template>
			<template v-else-if="step === 'importing'">
				<UiButton variant="secondary" @click="handleCancel">{{
					t('components.contacts.integrationImportModal.footer.cancelImport')
				}}</UiButton>
				<UiButton variant="secondary" @click="close">{{ t('common.close') }}</UiButton>
			</template>
			<template v-else-if="step === 'complete'">
				<UiButton @click="close">{{ t('common.done') }}</UiButton>
			</template>
		</template>
	</UiModal>
</template>
