<script setup lang="ts">
type PropertyType = 'string' | 'number' | 'boolean' | 'date';

// The contact properties page's "New property" modal: label, key (the page
// derives it from the label until edited) and type. The page validates and
// creates.
defineProps<{
	/** The page's create draft; the inputs write into it in place. */
	form: { key: string; label: string; type: PropertyType };
	errors: { key?: string; label?: string };
	isCreating: boolean;
	/** `label` / `description` are message keys. */
	types: ReadonlyArray<{ value: PropertyType; label: string; icon: string; description: string }>;
}>();

const emit = defineEmits<{ submit: []; cancel: [] }>();

const isOpen = defineModel<boolean>('open', { required: true });

const { t } = useI18n();
</script>

<template>
	<UiModal
		v-model:open="isOpen"
		:title="t('dashboard.admin.instance.properties.createModal.title')"
	>
		<form @submit.prevent="emit('submit')">
			<div class="space-y-4">
				<!-- Label -->
				<UiInput
					v-model="form.label"
					:label="t('dashboard.admin.instance.properties.fields.label')"
					:placeholder="t('dashboard.admin.instance.properties.fields.labelPlaceholder')"
					:error="errors.label"
					:disabled="isCreating"
					:required="true"
					:help-text="
						!errors.label ? t('dashboard.admin.instance.properties.fields.labelHelp') : undefined
					"
				/>

				<!-- Key -->
				<div>
					<UiInput
						v-model="form.key"
						:label="t('dashboard.admin.instance.properties.fields.key')"
						:placeholder="t('dashboard.admin.instance.properties.fields.keyPlaceholder')"
						:error="errors.key"
						:disabled="isCreating"
						:required="true"
					/>
					<I18nT
						v-if="!errors.key"
						keypath="dashboard.admin.instance.properties.fields.keyHelp"
						tag="p"
						scope="global"
						class="mt-1 text-xs text-text-tertiary"
					>
						<template #token>
							<code class="px-1 py-0.5 rounded bg-bg-surface text-text-primary"
								>&#123;&#123;{{
									form.key || t('dashboard.admin.instance.properties.fields.keyFallback')
								}}&#125;&#125;</code
							>
						</template>
					</I18nT>
				</div>

				<!-- Type -->
				<div>
					<label class="label">{{ t('dashboard.admin.instance.properties.fields.type') }}</label>
					<div class="grid grid-cols-2 gap-3">
						<button
							v-for="type in types"
							:key="type.value"
							type="button"
							:class="[
								'p-3 rounded-xl border text-left transition-colors',
								form.type === type.value
									? 'border-brand bg-brand/10'
									: 'border-border-subtle hover:border-border-default',
							]"
							:disabled="isCreating"
							@click="form.type = type.value"
						>
							<div class="flex items-center gap-2 mb-1">
								<Icon :name="type.icon" class="w-4 h-4 text-text-secondary" />
								<span class="font-medium text-text-primary text-sm">{{ t(type.label) }}</span>
							</div>
							<p class="text-xs text-text-secondary">{{ t(type.description) }}</p>
						</button>
					</div>
				</div>
			</div>
		</form>

		<template #footer>
			<UiButton variant="secondary" :disabled="isCreating" @click="emit('cancel')">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton :loading="isCreating" @click="emit('submit')">
				<template #iconLeft>
					<Icon v-if="!isCreating" name="lucide:plus" class="w-4 h-4" />
				</template>
				{{
					isCreating
						? t('dashboard.admin.instance.properties.createModal.creating')
						: t('dashboard.admin.instance.properties.createModal.create')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
