<script setup lang="ts">
/**
 * Auto-close editor for the Team Inbox: the on/off switch and how many quiet
 * days a conversation waiting on the customer stays open. Emits `save`; the
 * admin page persists it (`inbox/autoClose.ts` `savePolicy`, which applies the
 * same bounds). Presentational.
 */
import {
	AUTO_CLOSE_MAX_DAYS,
	AUTO_CLOSE_MIN_DAYS,
	autoCloseDaysProblem,
	type AutoClosePolicyShape,
} from '~/utils/inboxAutoClose';

const props = defineProps<{
	policy: AutoClosePolicyShape;
	busy?: boolean;
}>();

const emit = defineEmits<{ save: [policy: AutoClosePolicyShape] }>();

const { t } = useI18n();

const form = reactive({ ...props.policy });
watch(
	() => props.policy,
	(next) => Object.assign(form, next)
);

const problem = computed(() =>
	autoCloseDaysProblem(form.quietDays)
		? t('components.inbox.inboxAutoClosePolicyForm.problem')
		: null
);

function save() {
	if (problem.value) return;
	emit('save', { isEnabled: form.isEnabled, quietDays: form.quietDays });
}
</script>

<template>
	<UiCard data-testid="inbox-auto-close-form">
		<div class="flex items-center justify-between gap-4">
			<div>
				<h2 class="text-base font-medium text-text-primary">
					{{ t('components.inbox.inboxAutoClosePolicyForm.title') }}
				</h2>
				<p class="text-sm text-text-secondary">
					{{ t('components.inbox.inboxAutoClosePolicyForm.hint') }}
				</p>
			</div>
			<UiSwitch
				v-model="form.isEnabled"
				:label="t('components.inbox.inboxAutoClosePolicyForm.title')"
			/>
		</div>

		<div class="mt-4 flex flex-wrap items-center justify-between gap-3">
			<label class="flex items-center gap-2 text-sm text-text-primary">
				{{ t('components.inbox.inboxAutoClosePolicyForm.daysLabel') }}
				<input
					v-model.number="form.quietDays"
					type="number"
					:min="AUTO_CLOSE_MIN_DAYS"
					:max="AUTO_CLOSE_MAX_DAYS"
					step="1"
					class="input w-24"
					data-testid="inbox-auto-close-days"
				/>
				<span class="text-text-secondary">
					{{ t('components.inbox.inboxAutoClosePolicyForm.daysSuffix') }}
				</span>
			</label>
			<div class="flex items-center gap-3">
				<p v-if="problem" class="text-sm text-error" role="alert">{{ problem }}</p>
				<UiButton
					class="gap-2"
					:disabled="busy || !!problem"
					data-testid="inbox-auto-close-save"
					@click="save"
				>
					<Icon name="lucide:save" class="w-4 h-4" />
					{{ t('components.inbox.inboxAutoClosePolicyForm.save') }}
				</UiButton>
			</div>
		</div>
	</UiCard>
</template>
