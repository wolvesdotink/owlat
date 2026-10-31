<script setup lang="ts">
const emit = defineEmits<{
	select: [id: 'mailchimp' | 'stripe' | 'mandrill'];
	/** The empty state links away to the feature settings; the modal closes behind it. */
	close: [];
}>();

const { t } = useI18n();

/** `>` cannot live in a message value (the catalog guard rejects markup), so the
 *  breadcrumb separator is passed in as a value. */
const chevron = '>';

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
</script>

<template>
	<div>
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
				@click="emit('close')"
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
				@click="emit('select', integration.id)"
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
</template>
