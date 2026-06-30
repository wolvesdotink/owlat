<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { HandleDuplicates } from '~/composables/useCsvImport';

const props = defineProps<{
	topics?: Array<{ _id: string; name: string }>;
}>();

const convex = useConvex();
const { showToast } = useToast();

const isOpen = defineModel<boolean>('open', { default: false });

type IntegrationImportStep = 'select' | 'configure' | 'importing' | 'complete';
type IntegrationType = 'mailchimp' | 'stripe' | null;

const step = ref<IntegrationImportStep>('select');
const selectedIntegration = ref<IntegrationType>(null);
const error = ref('');
const handleDuplicates = ref<HandleDuplicates>('skip');
const selectedTopicId = ref<string | null>(null);

const credentials = reactive({
	mailchimp: { apiKey: '', listId: '', showApiKey: false },
	stripe: { apiKey: '', showApiKey: false },
});

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
	if (p.totalEstimate) {
		return `Imported ${processed.toLocaleString()} of ~${p.totalEstimate.toLocaleString()}...`;
	}
	return `Imported ${processed.toLocaleString()} contacts...`;
});

// Watch for import completion
watch(importProgress, (p) => {
	if (!p) return;

	if (step.value === 'importing' && p.status === 'completed') {
		step.value = 'complete';
		if (p.imported > 0 || p.updated > 0) {
			const totalProcessed = p.imported + p.updated;
			const name = p.provider === 'mailchimp' ? 'Mailchimp' : 'Stripe';
			showToast(
				`Successfully processed ${totalProcessed} contact${totalProcessed !== 1 ? 's' : ''} from ${name}`
			);
		}
	}

	if (step.value === 'importing' && p.status === 'failed') {
		const lastError = p.errors[p.errors.length - 1];
		// If nothing was imported, go back to configure with the error
		if (p.imported === 0 && p.updated === 0) {
			error.value = lastError || 'Import failed';
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
		name: 'Mailchimp',
		description: 'Import contacts from a Mailchimp audience list',
		icon: 'lucide:mail',
		color: 'text-[#FFE01B]',
		bgColor: 'bg-[#FFE01B]/10',
	},
	{
		id: 'stripe' as const,
		name: 'Stripe',
		description: 'Import customers from your Stripe account',
		icon: 'lucide:credit-card',
		color: 'text-[#635BFF]',
		bgColor: 'bg-[#635BFF]/10',
	},
];
const integrations = computed(() =>
	allIntegrations.filter((i) =>
		isFeatureEnabled(i.id === 'mailchimp' ? 'imports.mailchimp' : 'imports.stripe')
	)
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
			error.value = 'Mailchimp API key is required';
			return false;
		}
		if (!credentials.mailchimp.apiKey.includes('-')) {
			error.value =
				'Invalid API key format. Expected format: apikey-datacenter (e.g., abc123-us21)';
			return false;
		}
		if (!credentials.mailchimp.listId.trim()) {
			error.value = 'Audience List ID is required';
			return false;
		}
	} else if (selectedIntegration.value === 'stripe') {
		if (!credentials.stripe.apiKey.trim()) {
			error.value = 'Stripe API key is required';
			return false;
		}
		if (!credentials.stripe.apiKey.startsWith('sk_')) {
			error.value = 'Invalid Stripe API key. Must start with sk_ (secret key)';
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
				},
				handleDuplicates: handleDuplicates.value,
				topicId: topicId as Id<"topics"> | undefined,
			});
		} else if (selectedIntegration.value === 'stripe') {
			await convex.mutation(api.integrationImports.walker.startIntegrationImport, {
				config: {
					provider: 'stripe',
					apiKey: credentials.stripe.apiKey.trim(),
				},
				handleDuplicates: handleDuplicates.value,
				topicId: topicId as Id<"topics"> | undefined,
			});
		} else {
			throw new Error('No integration selected');
		}
		// Import started — progress will update via the reactive query
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to start import';
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

const integrationName = computed(() =>
	selectedIntegration.value === 'mailchimp' ? 'Mailchimp' : 'Stripe'
);
</script>

<template>
	<UiModal :open="isOpen" size="lg" @update:open="(v) => { if (!v) close(); }">
		<!-- Header -->
		<div class="flex items-center gap-3 mb-6">
			<UiIconBox icon="lucide:link-2" size="sm" variant="surface" rounded="lg" />
			<div>
				<h2 class="text-lg font-semibold text-text-primary">Import from Integration</h2>
				<p class="text-sm text-text-tertiary">
					<template v-if="step === 'select'">Choose an integration</template>
					<template v-else-if="step === 'configure'"
						>Configure {{ integrationName }}</template
					>
					<template v-else-if="step === 'importing'">Importing contacts...</template>
					<template v-else-if="step === 'complete'">Import complete</template>
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
								<p class="font-medium text-text-primary">No integrations enabled</p>
								<p class="text-sm text-text-tertiary mt-1 max-w-sm mx-auto">
									Turn on Mailchimp import or Stripe customer sync to import contacts from a connected
									service.
								</p>
								<NuxtLink
									to="/dashboard/settings/features"
									class="mt-4 inline-flex items-center gap-2 text-sm font-medium text-brand hover:underline"
									@click="close"
								>
									<Icon name="lucide:settings" class="w-4 h-4" />
									Enable in Settings &gt; Features
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
										<p class="font-medium text-text-primary">{{ integration.name }}</p>
										<p class="text-sm text-text-tertiary">{{ integration.description }}</p>
									</div>
									<Icon name="lucide:chevron-right" class="w-5 h-5 text-text-tertiary" />
								</button>
							</div>
							<div v-if="integrations.length > 0" class="mt-6 p-4 rounded-lg bg-bg-surface">
								<h4 class="text-sm font-medium text-text-primary mb-2">Note</h4>
								<p class="text-sm text-text-secondary">
									Your API keys are used only for this import and are not stored. We recommend using
									read-only API keys when available.
								</p>
							</div>
						</div>

						<!-- Step 2: Configure -->
						<div v-else-if="step === 'configure'">
							<!-- Mailchimp Config -->
							<div v-if="selectedIntegration === 'mailchimp'" class="space-y-4">
								<div>
									<label class="label">Mailchimp API Key <span class="text-error">*</span></label>
									<div class="relative">
										<input
											v-model="credentials.mailchimp.apiKey"
											:type="credentials.mailchimp.showApiKey ? 'text' : 'password'"
											placeholder="abc123def456-us21"
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
										Find your API key in Mailchimp: Account > Extras > API keys
									</p>
								</div>
								<div>
									<label for="credentials-mailchimp-listid" class="label">Audience List ID <span class="text-error">*</span></label>
									<input id="credentials-mailchimp-listid"
										v-model="credentials.mailchimp.listId"
										type="text"
										placeholder="abc123def4"
										class="input"
									/>
									<p class="text-xs text-text-tertiary mt-1">
										Find your List ID in Mailchimp: Audience > Settings > Audience name and defaults
									</p>
								</div>
							</div>

							<!-- Stripe Config -->
							<div v-else-if="selectedIntegration === 'stripe'" class="space-y-4">
								<div>
									<label class="label">Stripe Secret Key <span class="text-error">*</span></label>
									<div class="relative">
										<input
											v-model="credentials.stripe.apiKey"
											:type="credentials.stripe.showApiKey ? 'text' : 'password'"
											placeholder="sk_live_..."
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
										Find your API key in Stripe Dashboard: Developers > API keys
									</p>
								</div>
								<div class="p-4 rounded-lg bg-warning-subtle border border-warning/20">
									<div class="flex items-start gap-3">
										<Icon name="lucide:alert-circle" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
										<div>
											<p class="text-sm text-warning font-medium">Use a restricted key</p>
											<p class="text-xs text-warning/80 mt-1">
												For security, create a restricted API key with only "Customers: Read"
												permission.
											</p>
										</div>
									</div>
								</div>
							</div>

							<!-- Handle Duplicates -->
							<div class="mt-6 p-4 rounded-lg bg-bg-surface">
								<h4 class="text-sm font-medium text-text-primary mb-3">Handle Duplicates</h4>
								<div class="flex gap-4">
									<label class="flex items-center gap-2 cursor-pointer">
										<input
											v-model="handleDuplicates"
											type="radio"
											value="skip"
											class="w-4 h-4 text-brand"
										/>
										<span class="text-sm text-text-secondary">Skip duplicates</span>
									</label>
									<label class="flex items-center gap-2 cursor-pointer">
										<input
											v-model="handleDuplicates"
											type="radio"
											value="update"
											class="w-4 h-4 text-brand"
										/>
										<span class="text-sm text-text-secondary">Update existing</span>
									</label>
								</div>
							</div>

							<!-- Add to Topic -->
							<div v-if="availableLists.length > 0" class="mt-4 p-4 rounded-lg bg-bg-surface">
								<h4 class="text-sm font-medium text-text-primary mb-3">Add to Topic</h4>
								<select
									:value="selectedTopicId ?? ''"
									class="input w-full"
									@change="selectedTopicId = ($event.target as HTMLSelectElement).value || null"
								>
									<option value="">None</option>
									<option v-for="list in availableLists" :key="list._id" :value="list._id">
										{{ list.name }}
									</option>
								</select>
								<p class="text-xs text-text-tertiary mt-2">
									All imported contacts will be added to this topic.
								</p>
							</div>

							<!-- Field Mapping Info -->
							<div class="mt-4 p-4 rounded-lg bg-bg-surface">
								<h4 class="text-sm font-medium text-text-primary mb-2">Field Mapping</h4>
								<ul class="text-sm text-text-secondary space-y-1">
									<template v-if="selectedIntegration === 'mailchimp'">
										<li>Email > Email</li>
										<li>FNAME > First Name</li>
										<li>LNAME > Last Name</li>
									</template>
									<template v-else-if="selectedIntegration === 'stripe'">
										<li>Customer email > Email</li>
										<li>Customer name > First Name, Last Name</li>
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
										class="absolute inset-0 w-20 h-20 rounded-full border-4 border-brand border-t-transparent animate-spin"
									/>
								</div>
								<div class="text-center">
									<p class="text-lg font-medium text-text-primary">
										Importing from {{ integrationName }}...
									</p>
									<p class="text-sm text-text-tertiary mt-1">
										{{ progressText || 'Starting import...' }}
									</p>
								</div>
								<UiProgressBar
									class="max-w-xs"
									size="sm"
									:value="progressPercent"
									aria-label="Integration import progress"
								/>
								<p class="text-xs text-text-tertiary">
									You can close this dialog — the import will continue in the background.
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
									{{ importProgress?.status === 'failed' ? 'Import Failed' : 'Import Complete!' }}
								</p>
							</div>
							<div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
								<div class="p-4 rounded-lg bg-bg-surface text-center">
									<p class="text-2xl font-semibold text-success">{{ importProgress?.imported || 0 }}</p>
									<p class="text-xs text-text-tertiary mt-1">Imported</p>
								</div>
								<div class="p-4 rounded-lg bg-bg-surface text-center">
									<p class="text-2xl font-semibold text-brand">{{ importProgress?.updated || 0 }}</p>
									<p class="text-xs text-text-tertiary mt-1">Updated</p>
								</div>
								<div class="p-4 rounded-lg bg-bg-surface text-center">
									<p class="text-2xl font-semibold text-text-secondary">
										{{ importProgress?.skipped || 0 }}
									</p>
									<p class="text-xs text-text-tertiary mt-1">Skipped</p>
								</div>
								<div class="p-4 rounded-lg bg-bg-surface text-center">
									<p class="text-2xl font-semibold text-error">{{ importProgress?.failed || 0 }}</p>
									<p class="text-xs text-text-tertiary mt-1">Failed</p>
								</div>
							</div>
							<div
								v-if="importProgress?.errors && importProgress.errors.length > 0"
								class="p-4 rounded-lg bg-error-subtle border border-error/20"
							>
								<h4 class="text-sm font-medium text-error mb-2">Errors</h4>
								<ul class="text-sm text-error/80 space-y-1">
									<li v-for="(err, index) in importProgress.errors.slice(0, 5)" :key="index">{{ err }}</li>
								</ul>
							</div>
						</div>
			</div>

		<!-- Footer -->
		<template #footer>
			<template v-if="step === 'select'">
				<UiButton variant="secondary" @click="close">Cancel</UiButton>
			</template>
			<template v-else-if="step === 'configure'">
				<UiButton variant="secondary" @click="goBackToSelect">Back</UiButton>
				<UiButton @click="startImport">
					<template #iconLeft><Icon name="lucide:upload" class="w-4 h-4" /></template>
					Start Import
				</UiButton>
			</template>
			<template v-else-if="step === 'importing'">
				<UiButton variant="secondary" @click="handleCancel">Cancel Import</UiButton>
				<UiButton variant="secondary" @click="close">Close</UiButton>
			</template>
			<template v-else-if="step === 'complete'">
				<UiButton @click="close">Done</UiButton>
			</template>
		</template>
	</UiModal>
</template>
