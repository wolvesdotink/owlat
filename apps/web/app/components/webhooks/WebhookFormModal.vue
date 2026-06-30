<script setup lang="ts">
import { WEBHOOK_EVENTS, type WebhookEvent } from '~/composables/useWebhookForm';

interface Props {
	isOpen: boolean;
	title: string;
	submitLabel: string;
	submittingLabel: string;
	isSubmitting: boolean;
	formError: string | null;
	formName: string;
	formUrl: string;
	formEvents: WebhookEvent[];
	/** Show the "Select all / Clear" toggle for events (only in create mode) */
	showEventActions?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	showEventActions: false,
});

const emit = defineEmits<{
	close: [];
	submit: [];
	'update:formName': [value: string];
	'update:formUrl': [value: string];
	toggleEvent: [event: WebhookEvent];
	selectAllEvents: [];
	clearAllEvents: [];
}>();

const localName = computed({
	get: () => props.formName,
	set: (value: string) => emit('update:formName', value),
});

const localUrl = computed({
	get: () => props.formUrl,
	set: (value: string) => emit('update:formUrl', value),
});
</script>

<template>
	<UiModal
		:open="isOpen"
		:title="title"
		size="lg"
		:closable="!isSubmitting"
		:persistent="isSubmitting"
		@update:open="(v) => { if (!v) emit('close'); }"
	>
		<form id="webhook-form" @submit.prevent="emit('submit')">
			<!-- Error -->
			<div
				v-if="formError"
				class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20 flex items-start gap-3"
			>
				<Icon name="lucide:alert-circle" class="w-5 h-5 text-error shrink-0 mt-0.5" />
				<p class="text-sm text-error">{{ formError }}</p>
			</div>

			<!-- Name Field -->
			<div class="mb-4">
				<label for="webhook-form-name" class="label">
					Name <span class="text-error">*</span>
				</label>
				<input
					id="webhook-form-name"
					v-model="localName"
					type="text"
					placeholder="e.g., Email Events, CRM Integration"
					class="input"
					:disabled="isSubmitting"
				/>
			</div>

			<!-- URL Field -->
			<div class="mb-4">
				<label for="webhook-form-url" class="label">
					Endpoint URL <span class="text-error">*</span>
				</label>
				<input
					id="webhook-form-url"
					v-model="localUrl"
					type="url"
					placeholder="https://your-server.com/webhooks"
					class="input"
					:disabled="isSubmitting"
				/>
				<p class="mt-1 text-xs text-text-tertiary">
					We'll send POST requests to this URL when events occur.
				</p>
			</div>

			<!-- Events Field -->
			<div>
				<div class="flex items-center justify-between mb-2">
					<label class="label mb-0"> Events <span class="text-error">*</span> </label>
					<div v-if="showEventActions" class="flex items-center gap-2">
						<button
							type="button"
							class="text-xs text-brand hover:text-brand-hover"
							@click="emit('selectAllEvents')"
						>
							Select all
						</button>
						<span class="text-text-tertiary">|</span>
						<button
							type="button"
							class="text-xs text-text-secondary hover:text-text-primary"
							@click="emit('clearAllEvents')"
						>
							Clear
						</button>
					</div>
				</div>
				<div class="grid gap-2">
					<label
						v-for="event in WEBHOOK_EVENTS"
						:key="event.value"
						:class="[
							'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
							formEvents.includes(event.value)
								? 'border-brand bg-brand/5'
								: 'border-border-subtle hover:border-border-default',
						]"
					>
						<input
							type="checkbox"
							:checked="formEvents.includes(event.value)"
							class="sr-only"
							@change="emit('toggleEvent', event.value)"
						/>
						<div
							:class="[
								'w-4 h-4 rounded border-2 flex items-center justify-center shrink-0',
								formEvents.includes(event.value)
									? 'border-brand bg-brand'
									: 'border-border-default',
							]"
						>
							<Icon
								v-if="formEvents.includes(event.value)"
								name="lucide:check"
								class="w-3 h-3 text-text-inverse"
							/>
						</div>
						<div>
							<p class="text-sm font-medium text-text-primary">{{ event.label }}</p>
							<p class="text-xs text-text-tertiary">{{ event.description }}</p>
						</div>
					</label>
				</div>
			</div>
		</form>

		<template #footer>
			<button
				type="button"
				class="btn btn-secondary"
				:disabled="isSubmitting"
				@click="emit('close')"
			>
				Cancel
			</button>
			<button
				type="submit"
				form="webhook-form"
				class="btn btn-primary gap-2"
				:disabled="isSubmitting"
			>
				<Icon v-if="isSubmitting" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
				{{ isSubmitting ? submittingLabel : submitLabel }}
			</button>
		</template>
	</UiModal>
</template>
