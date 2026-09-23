<script setup lang="ts">
/**
 * The AI replies page's single top control: Draft only / Send automatically
 * when confident / Off. Presentational — the page maps the choice onto the
 * stored settings (see `~/utils/aiReplyMode`) and passes the derived mode back
 * in. A native radio group, so arrow keys move between the three choices.
 */
import { useId } from 'vue';
import { AI_REPLY_MODES, type AiReplyMode } from '~/utils/aiReplyMode';

const props = withDefaults(
	defineProps<{
		mode: AiReplyMode;
		/** A write is in flight: every choice is locked until it settles. */
		busy?: boolean;
		/** False while AI or the team inbox is off: only Off can be chosen. */
		canTurnOn?: boolean;
	}>(),
	{ busy: false, canTurnOn: true }
);

const emit = defineEmits<{ select: [mode: AiReplyMode] }>();

const { t } = useI18n();
const name = `ai-reply-mode-${useId()}`;

const isDisabled = (mode: AiReplyMode) => props.busy || (mode !== 'off' && !props.canTurnOn);

function onChange(mode: AiReplyMode) {
	if (mode !== props.mode && !isDisabled(mode)) emit('select', mode);
}
</script>

<template>
	<fieldset class="space-y-2" data-testid="ai-reply-mode">
		<legend class="sr-only">{{ t('components.settings.aiReplyModeControl.legend') }}</legend>
		<label
			v-for="option in AI_REPLY_MODES"
			:key="option"
			class="flex items-start gap-3 rounded-lg border p-4 transition-colors"
			:class="[
				mode === option
					? 'border-brand/50 bg-brand-subtle/40'
					: 'border-border-subtle hover:border-border-default',
				isDisabled(option) ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
			]"
			:data-testid="`ai-reply-mode-${option}`"
		>
			<input
				type="radio"
				class="mt-1 h-4 w-4 accent-brand"
				:name="name"
				:value="option"
				:checked="mode === option"
				:disabled="isDisabled(option)"
				@change="onChange(option)"
			/>
			<span class="min-w-0">
				<span class="flex items-center gap-2 font-medium text-text-primary">
					{{ t(`components.settings.aiReplyModeControl.options.${option}.label`) }}
					<span
						v-if="option === 'draft'"
						class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-bg-surface text-text-secondary"
					>
						{{ t('components.settings.aiReplyModeControl.defaultBadge') }}
					</span>
				</span>
				<span class="block text-sm text-text-secondary mt-0.5">
					{{ t(`components.settings.aiReplyModeControl.options.${option}.description`) }}
				</span>
			</span>
		</label>
	</fieldset>
</template>
