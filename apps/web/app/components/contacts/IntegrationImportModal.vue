<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { HandleDuplicates } from '~/composables/useCsvImport';

const props = defineProps<{
	topics?: Array<{ _id: string; name: string }>;
}>();

const { t, locale } = useI18n();

const convex = useConvex();
const { showToast } = useToast();

/** `>` cannot live in a message value (the catalog guard rejects markup), so the
 *  breadcrumb separator is passed in as a value. */
const chevron = '>';

const formatCount = (value: number) => new Intl.NumberFormat(locale.value).format(value);

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

// Computed progress percentage
const progressPercent = computed(() => {
	const p = importProgress.value;
	if (!p || p.status !== 'running') return 0;
	const processed = p.imported + p.updated + p.skipped + p.failed;
	if (p.totalEstimate && p.totalEstimate > 0) {
		return Math.min(Math.round((processed / p.totalEstimate) * 100), 99);
	}
	// Stripe doesn't provide total — show indeterminate-ish progress
	return processed > 0 ? Math.min(processed, 99) : 5;
});

// Computed progress text
const progressText = computed(() => {
	const p = importProgress.value;
	if (!p || p.status !== 'running') return '';
	const processed = p.imported + p.updated + p.skipped + p.failed;
	if (p.provider === 'mandrill') {
		const carried = p.suppressionCounts;
		const seen = carried
			? carried.bouncedHard +
				carried.bouncedSoft +
				carried.complained +
				carried.manual +
				carried.unsubscribed +
				carried.alreadyBlocked +
				carried.alreadyUnsubscribed +
				carried.noContact +
				carried.skipped
			: 0;
		return p.totalEstimate
			? t('components.contacts.integrationImportModal.progress.reviewedOfTotal', {
					seen: formatCount(seen),
					total: formatCount(p.totalEstimate),
				})
			: t('components.contacts.integrationImportModal.progress.reviewed', {
					seen: formatCount(seen),
				});
	}
	if (p.totalEstimate) {
		return t('components.contacts.integrationImportModal.progress.importedOfTotal', {
			processed: formatCount(processed),
			total: formatCount(p.totalEstimate),
		});
	}
	return t('components.contacts.integrationImportModal.progress.imported', {
		processed: formatCount(processed),
	});
});

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

const { isEnabled: isFeatureEnabled } = useFeatureFlag();

// Only offer providers whose feature flag is on — the backend enforces the
// same flags in startIntegrationImport.
const allIntegrations = [
	{
		id: 'mailchimp' as const,
		// Message KEYS, not copy: this list is built once at setup, so the
		// component translates `name`/`description` where it renders them.
		name: 'components.contacts.integrationImportModal.providers.mailchimp.name',
		description: 'components.contacts.integrationImportModal.providers.mailchimp.description',
		icon: 'lucide:mail',
		color: 'text-[#FFE01B]',
		bgColor: 'bg-[#FFE01B]/10',
	},
	{
		id: 'stripe' as const,
		name: 'components.contacts.integrationImportModal.providers.stripe.name',
		description: 'components.contacts.integrationImportModal.providers.stripe.description',
		icon: 'lucide:credit-card',
		color: 'text-[#635BFF]',
		bgColor: 'bg-[#635BFF]/10',
	},
	{
		id: 'mandrill' as const,
		name: 'components.contacts.integrationImportModal.providers.mandrill.name',
		description: 'components.contacts.integrationImportModal.providers.mandrill.description',
		icon: 'lucide:shield-ban',
		color: 'text-[#F0483E]',
		bgColor: 'bg-[#F0483E]/10',
	},
];
const FLAG_FOR_INTEGRATION = {
	mailchimp: 'imports.mailchimp',
	stripe: 'imports.stripe',
	mandrill: 'imports.mandrill',
} as const;
const integrations = computed(() =>
	allIntegrations.filter((i) => isFeatureEnabled(FLAG_FOR_INTEGRATION[i.id]))
);

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
			// environment, the same one the send transport uses (plan D2).
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
			throw new Error(
				t('components.contacts.integrationImportModal.errors.noIntegrationSelected')
			);
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

const suppressionSummary = computed(() => {
	const counts = importProgress.value?.suppressionCounts;
	if (!counts) return null;
	const blocked = counts.bouncedHard + counts.bouncedSoft + counts.complained + counts.manual;
	return {
		blocked,
		unsubscribed: counts.unsubscribed,
		alreadySuppressed: counts.alreadyBlocked + counts.alreadyUnsubscribed,
		skipped: counts.skipped + counts.noContact,
	};
});
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

		<!-- Content -->
		<div class="max-h-[70vh] overflow-y-auto">
			<!-- Error Alert -->
			<div
				v-if="error"
				class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20 flex items-start gap-3"
			>
				<Icon name="lucide:alert-circle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
				<p class="text-sm text-error">{{ error }}</p>
			</div>

			<!-- Step 1: Select -->
			<div v-if="step === 'select'">
				<!-- Empty state: no providers enabled -->
				<div
					v-if="integrations.length === 0"
					class="p-6 rounded-xl border border-border-subtle bg-bg-surface text-center"
				>
					<div class="inline-flex p-3 rounded-full bg-bg-elevated mb-3">
						<Icon name="lucide:toggle-right" class="w-6 h-6 text-text-tertiary" />
					</div>
					<p class="font-medium text-text-primary">
						{{ t('components.contacts.integrationImportModal.select.emptyTitle') }}
					</p>
					<p class="text-sm text-text-tertiary mt-1 max-w-sm mx-auto">
						{{ t('components.contacts.integrationImportModal.select.emptyBody') }}
					</p>
					<NuxtLink
						to="/dashboard/admin/instance/features"
						class="mt-4 inline-flex items-center gap-2 text-sm font-medium text-brand hover:underline"
						@click="close"
					>
						<Icon name="lucide:settings" class="w-4 h-4" />
						{{ t('components.contacts.integrationImportModal.select.enableLink', { chevron }) }}
					</NuxtLink>
				</div>
				<div v-else class="space-y-3">
					<button
						v-for="integration in integrations"
						:key="integration.id"
						class="w-full p-4 rounded-xl border border-border-subtle hover:border-border-default bg-bg-surface hover:bg-bg-surface/80 transition-colors text-left flex items-center gap-4"
						@click="selectIntegration(integration.id)"
					>
						<div :class="['p-3 rounded-lg', integration.bgColor]">
							<Icon :name="integration.icon" :class="['w-6 h-6', integration.color]" />
						</div>
						<div class="flex-1">
							<p class="font-medium text-text-primary">{{ t(integration.name) }}</p>
							<p class="text-sm text-text-tertiary">{{ t(integration.description) }}</p>
						</div>
						<Icon name="lucide:chevron-right" class="w-5 h-5 text-text-tertiary" />
					</button>
				</div>
				<div v-if="integrations.length > 0" class="mt-6 p-4 rounded-lg bg-bg-surface">
					<h4 class="text-sm font-medium text-text-primary mb-2">
						{{ t('components.contacts.integrationImportModal.select.noteTitle') }}
					</h4>
					<p class="text-sm text-text-secondary">
						{{ t('components.contacts.integrationImportModal.select.noteBody') }}
					</p>
				</div>
			</div>

			<!-- Step 2: Configure -->
			<div v-else-if="step === 'configure'">
				<!-- Mailchimp Config -->
				<div v-if="selectedIntegration === 'mailchimp'" class="space-y-4">
					<div>
						<label class="label"
							>{{ t('components.contacts.integrationImportModal.configure.mailchimpApiKey') }}
							<span class="text-error">*</span></label
						>
						<div class="relative">
							<input
								v-model="credentials.mailchimp.apiKey"
								:type="credentials.mailchimp.showApiKey ? 'text' : 'password'"
								:placeholder="
									t('components.contacts.integrationImportModal.configure.mailchimpApiKeyPlaceholder')
								"
								class="input pr-10"
							/>
							<button
								type="button"
								class="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
								@click="credentials.mailchimp.showApiKey = !credentials.mailchimp.showApiKey"
							>
								<Icon v-if="!credentials.mailchimp.showApiKey" name="lucide:eye" class="w-4 h-4" />
								<Icon v-else name="lucide:eye-off" class="w-4 h-4" />
							</button>
						</div>
						<p class="text-xs text-text-tertiary mt-1">
							{{
								t('components.contacts.integrationImportModal.configure.mailchimpApiKeyHint', {
									chevron,
								})
							}}
						</p>
					</div>
					<div>
						<label for="credentials-mailchimp-listid" class="label"
							>{{ t('components.contacts.integrationImportModal.configure.audienceListId') }}
							<span class="text-error">*</span></label
						>
						<input
							id="credentials-mailchimp-listid"
							v-model="credentials.mailchimp.listId"
							type="text"
							:placeholder="
								t('components.contacts.integrationImportModal.configure.audienceListIdPlaceholder')
							"
							class="input"
						/>
						<p class="text-xs text-text-tertiary mt-1">
							{{
								t('components.contacts.integrationImportModal.configure.audienceListIdHint', {
									chevron,
								})
							}}
						</p>
					</div>
					<label class="flex items-start gap-3 p-4 rounded-lg bg-bg-surface cursor-pointer">
						<input v-model="importSuppressions" type="checkbox" class="w-4 h-4 mt-0.5 text-brand" />
						<span>
							<span class="block text-sm font-medium text-text-primary">{{
								t('components.contacts.integrationImportModal.configure.carrySuppressions')
							}}</span>
							<span class="block text-xs text-text-tertiary mt-1">
								{{ t('components.contacts.integrationImportModal.configure.carrySuppressionsHint') }}
							</span>
						</span>
					</label>
				</div>

				<!-- Mandrill Config — nothing to configure: the key is an
							     environment variable (plan D2). -->
				<div v-else-if="selectedIntegration === 'mandrill'" class="space-y-4">
					<div class="p-4 rounded-lg bg-bg-surface">
						<I18nT
							keypath="components.contacts.integrationImportModal.configure.mandrillBody"
							tag="p"
							class="text-sm text-text-secondary"
							scope="global"
						>
							<template #apiKeyVar><code>MANDRILL_API_KEY</code></template>
							<template #unsubEntry><code>unsub</code></template>
						</I18nT>
						<p class="text-xs text-text-tertiary mt-2">
							{{ t('components.contacts.integrationImportModal.configure.mandrillNote') }}
						</p>
					</div>
				</div>

				<!-- Stripe Config -->
				<div v-else-if="selectedIntegration === 'stripe'" class="space-y-4">
					<div>
						<label class="label"
							>{{ t('components.contacts.integrationImportModal.configure.stripeSecretKey') }}
							<span class="text-error">*</span></label
						>
						<div class="relative">
							<input
								v-model="credentials.stripe.apiKey"
								:type="credentials.stripe.showApiKey ? 'text' : 'password'"
								:placeholder="
									t('components.contacts.integrationImportModal.configure.stripeSecretKeyPlaceholder')
								"
								class="input pr-10"
							/>
							<button
								type="button"
								class="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-primary"
								@click="credentials.stripe.showApiKey = !credentials.stripe.showApiKey"
							>
								<Icon v-if="!credentials.stripe.showApiKey" name="lucide:eye" class="w-4 h-4" />
								<Icon v-else name="lucide:eye-off" class="w-4 h-4" />
							</button>
						</div>
						<p class="text-xs text-text-tertiary mt-1">
							{{
								t('components.contacts.integrationImportModal.configure.stripeApiKeyHint', {
									chevron,
								})
							}}
						</p>
					</div>
					<div class="p-4 rounded-lg bg-warning-subtle border border-warning/20">
						<div class="flex items-start gap-3">
							<Icon name="lucide:alert-circle" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
							<div>
								<p class="text-sm text-warning font-medium">
									{{ t('components.contacts.integrationImportModal.configure.restrictedKeyTitle') }}
								</p>
								<p class="text-xs text-warning/80 mt-1">
									{{ t('components.contacts.integrationImportModal.configure.restrictedKeyBody') }}
								</p>
							</div>
						</div>
					</div>
				</div>

				<!-- Handle Duplicates (contact imports only) -->
				<div v-if="selectedIntegration !== 'mandrill'" class="mt-6 p-4 rounded-lg bg-bg-surface">
					<h4 class="text-sm font-medium text-text-primary mb-3">
						{{ t('components.contacts.integrationImportModal.configure.handleDuplicates') }}
					</h4>
					<div class="flex gap-4">
						<label class="flex items-center gap-2 cursor-pointer">
							<input
								v-model="handleDuplicates"
								type="radio"
								value="skip"
								class="w-4 h-4 text-brand"
							/>
							<span class="text-sm text-text-secondary">{{
								t('components.contacts.integrationImportModal.configure.skipDuplicates')
							}}</span>
						</label>
						<label class="flex items-center gap-2 cursor-pointer">
							<input
								v-model="handleDuplicates"
								type="radio"
								value="update"
								class="w-4 h-4 text-brand"
							/>
							<span class="text-sm text-text-secondary">{{
								t('components.contacts.integrationImportModal.configure.updateExisting')
							}}</span>
						</label>
					</div>
				</div>

				<!-- Add to Topic -->
				<div
					v-if="availableLists.length > 0 && selectedIntegration !== 'mandrill'"
					class="mt-4 p-4 rounded-lg bg-bg-surface"
				>
					<h4 class="text-sm font-medium text-text-primary mb-3">
						{{ t('components.contacts.integrationImportModal.configure.addToTopic') }}
					</h4>
					<select
						:value="selectedTopicId ?? ''"
						class="input w-full"
						@change="selectedTopicId = ($event.target as HTMLSelectElement).value || null"
					>
						<option value="">{{ t('common.none') }}</option>
						<option v-for="list in availableLists" :key="list._id" :value="list._id">
							{{ list.name }}
						</option>
					</select>
					<p class="text-xs text-text-tertiary mt-2">
						{{ t('components.contacts.integrationImportModal.configure.addToTopicHint') }}
					</p>
				</div>

				<!-- Field Mapping Info -->
				<div v-if="selectedIntegration !== 'mandrill'" class="mt-4 p-4 rounded-lg bg-bg-surface">
					<h4 class="text-sm font-medium text-text-primary mb-2">
						{{ t('components.contacts.integrationImportModal.configure.fieldMapping') }}
					</h4>
					<ul class="text-sm text-text-secondary space-y-1">
						<template v-if="selectedIntegration === 'mailchimp'">
							<li>
								{{
									t('components.contacts.integrationImportModal.fieldMapping.mailchimpEmail', {
										chevron,
									})
								}}
							</li>
							<li>
								{{
									t('components.contacts.integrationImportModal.fieldMapping.mailchimpFirstName', {
										chevron,
									})
								}}
							</li>
							<li>
								{{
									t('components.contacts.integrationImportModal.fieldMapping.mailchimpLastName', {
										chevron,
									})
								}}
							</li>
						</template>
						<template v-else-if="selectedIntegration === 'stripe'">
							<li>
								{{
									t('components.contacts.integrationImportModal.fieldMapping.stripeEmail', {
										chevron,
									})
								}}
							</li>
							<li>
								{{
									t('components.contacts.integrationImportModal.fieldMapping.stripeName', {
										chevron,
									})
								}}
							</li>
						</template>
					</ul>
				</div>
			</div>

			<!-- Step 3: Importing -->
			<div v-else-if="step === 'importing'" class="py-8">
				<div class="flex flex-col items-center gap-6">
					<div class="relative">
						<div class="w-20 h-20 rounded-full border-4 border-bg-surface" />
						<div
							class="absolute inset-0 w-20 h-20 rounded-full border-4 border-brand border-t-transparent animate-spin motion-reduce:animate-none"
						/>
					</div>
					<div class="text-center">
						<p class="text-lg font-medium text-text-primary">
							{{
								t('components.contacts.integrationImportModal.importing.title', {
									provider: integrationName,
								})
							}}
						</p>
						<p class="text-sm text-text-tertiary mt-1">
							{{
								progressText || t('components.contacts.integrationImportModal.importing.starting')
							}}
						</p>
					</div>
					<UiProgressBar
						class="max-w-xs"
						size="sm"
						:value="progressPercent"
						:aria-label="t('components.contacts.integrationImportModal.importing.progressLabel')"
					/>
					<p class="text-xs text-text-tertiary">
						{{ t('components.contacts.integrationImportModal.importing.background') }}
					</p>
				</div>
			</div>

			<!-- Step 4: Complete -->
			<div v-else-if="step === 'complete'" class="py-4">
				<div class="flex flex-col items-center gap-4 mb-6">
					<div
						:class="[
							'p-3 rounded-full',
							importProgress?.status === 'failed' ? 'bg-error/10' : 'bg-success/10',
						]"
					>
						<Icon
							:name="importProgress?.status === 'failed' ? 'lucide:alert-triangle' : 'lucide:check'"
							:class="[
								'w-8 h-8',
								importProgress?.status === 'failed' ? 'text-error' : 'text-success',
							]"
						/>
					</div>
					<p class="text-lg font-medium text-text-primary">
						{{
							importProgress?.status === 'failed'
								? t('components.contacts.integrationImportModal.complete.failedTitle')
								: t('components.contacts.integrationImportModal.complete.title')
						}}
					</p>
				</div>
				<div v-if="!isSuppressionOnly" class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
					<div class="p-4 rounded-lg bg-bg-surface text-center">
						<p class="text-2xl font-medium tracking-[-0.02em] text-success">{{ importProgress?.imported || 0 }}</p>
						<p class="text-xs text-text-tertiary mt-1">
							{{ t('components.contacts.integrationImportModal.complete.imported') }}
						</p>
					</div>
					<div class="p-4 rounded-lg bg-bg-surface text-center">
						<p class="text-2xl font-medium tracking-[-0.02em] text-brand">{{ importProgress?.updated || 0 }}</p>
						<p class="text-xs text-text-tertiary mt-1">
							{{ t('components.contacts.integrationImportModal.complete.updated') }}
						</p>
					</div>
					<div class="p-4 rounded-lg bg-bg-surface text-center">
						<p class="text-2xl font-medium tracking-[-0.02em] text-text-secondary">
							{{ importProgress?.skipped || 0 }}
						</p>
						<p class="text-xs text-text-tertiary mt-1">
							{{ t('components.contacts.integrationImportModal.complete.skipped') }}
						</p>
					</div>
					<div class="p-4 rounded-lg bg-bg-surface text-center">
						<p class="text-2xl font-medium tracking-[-0.02em] text-error">{{ importProgress?.failed || 0 }}</p>
						<p class="text-xs text-text-tertiary mt-1">
							{{ t('components.contacts.integrationImportModal.complete.failed') }}
						</p>
					</div>
				</div>
				<!-- Suppression carry-over (plan D9) -->
				<div v-if="suppressionSummary" class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
					<div class="p-4 rounded-lg bg-bg-surface text-center">
						<p class="text-2xl font-medium tracking-[-0.02em] text-warning">{{ suppressionSummary.blocked }}</p>
						<p class="text-xs text-text-tertiary mt-1">
							{{ t('components.contacts.integrationImportModal.complete.suppressed') }}
						</p>
					</div>
					<div class="p-4 rounded-lg bg-bg-surface text-center">
						<p class="text-2xl font-medium tracking-[-0.02em] text-brand">{{ suppressionSummary.unsubscribed }}</p>
						<p class="text-xs text-text-tertiary mt-1">
							{{ t('components.contacts.integrationImportModal.complete.unsubscribed') }}
						</p>
					</div>
					<div class="p-4 rounded-lg bg-bg-surface text-center">
						<p class="text-2xl font-medium tracking-[-0.02em] text-text-secondary">
							{{ suppressionSummary.alreadySuppressed }}
						</p>
						<p class="text-xs text-text-tertiary mt-1">
							{{ t('components.contacts.integrationImportModal.complete.alreadySuppressed') }}
						</p>
					</div>
					<div class="p-4 rounded-lg bg-bg-surface text-center">
						<p class="text-2xl font-medium tracking-[-0.02em] text-text-secondary">
							{{ suppressionSummary.skipped }}
						</p>
						<p class="text-xs text-text-tertiary mt-1">
							{{ t('components.contacts.integrationImportModal.complete.notApplicable') }}
						</p>
					</div>
				</div>

				<div
					v-if="importProgress?.errors && importProgress.errors.length > 0"
					class="p-4 rounded-lg bg-error-subtle border border-error/20"
				>
					<h4 class="text-sm font-medium text-error mb-2">
						{{ t('components.contacts.integrationImportModal.complete.errorsTitle') }}
					</h4>
					<ul class="text-sm text-error/80 space-y-1">
						<li v-for="(err, index) in importProgress.errors.slice(0, 5)" :key="index">
							{{ err }}
						</li>
					</ul>
				</div>
			</div>
		</div>

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
