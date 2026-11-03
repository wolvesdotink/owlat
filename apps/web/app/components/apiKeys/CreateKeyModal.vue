<script setup lang="ts">
import { CircleWarningIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

defineProps<{
	open: boolean;
	isCreating: boolean;
	/** Field-bound create error, shown above the name input. */
	error: string | null;
	/** The page's draft; the inputs write into it in place. */
	form: { name: string; scopes: string[] };
}>();

const emit = defineEmits<{ close: []; submit: [] }>();

const { t } = useI18n();

// Scopes are least-privilege by construction: the operator must pick at least
// one, and the key carries exactly those (the backend rejects an empty list).
// Mirrors the canonical vocabulary in apps/api/convex/auth/apiScopes.ts; the
// backend validates against it, so a drift here can only under-offer, never
// grant an unknown scope.
const AVAILABLE_SCOPES = computed<
	ReadonlyArray<{ value: string; label: string; description: string }>
>(() => [
	{
		value: 'contacts:read',
		label: t('dashboard.admin.team.api.index.scopes.contactsRead.label'),
		description: t('dashboard.admin.team.api.index.scopes.contactsRead.description'),
	},
	{
		value: 'contacts:write',
		label: t('dashboard.admin.team.api.index.scopes.contactsWrite.label'),
		description: t('dashboard.admin.team.api.index.scopes.contactsWrite.description'),
	},
	{
		value: 'events:write',
		label: t('dashboard.admin.team.api.index.scopes.eventsWrite.label'),
		description: t('dashboard.admin.team.api.index.scopes.eventsWrite.description'),
	},
	{
		value: 'transactional:send',
		label: t('dashboard.admin.team.api.index.scopes.transactionalSend.label'),
		description: t('dashboard.admin.team.api.index.scopes.transactionalSend.description'),
	},
	{
		value: 'topics:write',
		label: t('dashboard.admin.team.api.index.scopes.topicsWrite.label'),
		description: t('dashboard.admin.team.api.index.scopes.topicsWrite.description'),
	},
]);
</script>

<template>
	<UiModal
		:open="open"
		:title="t('dashboard.admin.team.api.index.createKey')"
		size="md"
		:closable="!isCreating"
		:persistent="isCreating"
		@update:open="
			(v) => {
				if (!v) emit('close');
			}
		"
	>
		<!-- Form -->
		<form @submit.prevent="emit('submit')">
			<!-- Error -->
			<div
				v-if="error"
				class="mb-4 p-3 rounded-lg bg-error-subtle border border-error/20 flex items-start gap-3"
			>
				<CircleWarningIcon class="w-5 h-5 text-error shrink-0 mt-0.5" />
				<p class="text-sm text-error">{{ error }}</p>
			</div>

			<!-- Name Field -->
			<div class="mb-6">
				<label for="key-name" class="label">
					{{ t('common.name') }} <span class="text-error">*</span>
				</label>
				<input
					id="key-name"
					v-model="form.name"
					type="text"
					:placeholder="t('dashboard.admin.team.api.index.form.namePlaceholder')"
					class="input"
					:disabled="isCreating"
				/>
				<p class="mt-1 text-xs text-text-tertiary">
					{{ t('dashboard.admin.team.api.index.form.nameHelp') }}
				</p>
			</div>

			<!-- Scopes Field -->
			<div>
				<span class="label"
					>{{ t('dashboard.admin.team.api.index.form.scopesLabel') }}
					<span class="text-error">*</span></span
				>
				<p class="mb-2 text-xs text-text-tertiary">
					{{ t('dashboard.admin.team.api.index.form.scopesHelp') }}
				</p>
				<div class="space-y-2">
					<label
						v-for="scope in AVAILABLE_SCOPES"
						:key="scope.value"
						class="flex items-start gap-3 p-3 rounded-lg shadow-surface-1 cursor-pointer hover:bg-bg-surface-hover"
						:class="{ 'opacity-60 cursor-not-allowed': isCreating }"
					>
						<input
							v-model="form.scopes"
							type="checkbox"
							:value="scope.value"
							:disabled="isCreating"
							class="mt-0.5 shrink-0"
						/>
						<span>
							<span class="block text-sm font-medium text-text-primary">{{ scope.label }}</span>
							<span class="block text-xs text-text-tertiary">{{ scope.description }}</span>
						</span>
					</label>
				</div>
			</div>
		</form>

		<template #footer>
			<UiButton variant="secondary" type="button" :disabled="isCreating" @click="emit('close')">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton type="button" class="gap-2" :disabled="isCreating" @click="emit('submit')">
				<SpinnerIcon v-if="isCreating" class="w-4 h-4" />
				{{
					isCreating
						? t('dashboard.admin.team.api.index.form.creating')
						: t('dashboard.admin.team.api.index.form.submit')
				}}
			</UiButton>
		</template>
	</UiModal>
</template>
