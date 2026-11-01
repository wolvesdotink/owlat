<script setup lang="ts">
// The campaign editor's "Campaign details" card: name and reply-to. The sender
// picker goes in the default slot, so the page keeps its template ref (every
// save validates through it).
defineProps<{
	nameError?: string;
	disabled: boolean;
}>();

const campaignName = defineModel<string>('campaignName', { required: true });
const replyTo = defineModel<string>('replyTo', { required: true });

const { t } = useI18n();
</script>

<template>
	<div class="card p-6">
		<h2 class="text-lg font-semibold text-text-primary mb-6">
			{{ t('dashboard.campaigns.detail.edit.details.title') }}
		</h2>

		<div class="space-y-6">
			<!-- Campaign Name -->
			<div>
				<label for="campaignName" class="label flex items-center gap-2">
					<Icon name="lucide:file-text" class="w-4 h-4 text-text-tertiary" />
					{{ t('dashboard.campaigns.detail.edit.details.campaignName') }}
					<span class="text-error">*</span>
				</label>
				<input
					id="campaignName"
					v-model="campaignName"
					type="text"
					:placeholder="t('dashboard.campaigns.detail.edit.details.campaignNamePlaceholder')"
					:class="['input mt-1.5', nameError ? 'input-error' : '']"
					:disabled="disabled"
				/>
				<p v-if="nameError" class="mt-1.5 text-sm text-error">
					{{ nameError }}
				</p>
			</div>

			<slot />

			<!-- Reply-to -->
			<div>
				<label for="replyTo" class="label flex items-center gap-2">
					<Icon name="lucide:reply" class="w-4 h-4 text-text-tertiary" />
					{{ t('dashboard.campaigns.detail.edit.details.replyTo') }}
					<span class="text-text-tertiary">{{
						t('dashboard.campaigns.detail.edit.details.optionalSuffix')
					}}</span>
				</label>
				<input
					id="replyTo"
					v-model="replyTo"
					type="email"
					:placeholder="t('dashboard.campaigns.detail.edit.details.replyToPlaceholder')"
					class="input mt-1.5"
					:disabled="disabled"
				/>
			</div>
		</div>
	</div>
</template>
