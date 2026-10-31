<script setup lang="ts">
import type { HandleDuplicates } from '~/composables/useCsvImport';

defineProps<{
	selectedIntegration: 'mailchimp' | 'stripe' | 'mandrill' | null;
	/** The modal's reactive form state; the inputs write into it in place. */
	credentials: {
		mailchimp: { apiKey: string; listId: string; showApiKey: boolean };
		stripe: { apiKey: string; showApiKey: boolean };
	};
	availableLists: Array<{ _id: string; name: string }>;
}>();

const handleDuplicates = defineModel<HandleDuplicates>('handleDuplicates', { required: true });
const selectedTopicId = defineModel<string | null>('selectedTopicId', { required: true });
const importSuppressions = defineModel<boolean>('importSuppressions', { required: true });

const { t } = useI18n();

/** `>` cannot live in a message value (the catalog guard rejects markup), so the
 *  breadcrumb separator is passed in as a value. */
const chevron = '>';
</script>

<template>
	<div>
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
					     environment variable. -->
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
					<input v-model="handleDuplicates" type="radio" value="skip" class="w-4 h-4 text-brand" />
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
</template>
