<script setup lang="ts">
/**
 * The "changed from default" marker for one setting: a dot saying the value is
 * not the shipped default, and a Reset that puts the default back. Renders
 * nothing while the value is the default, so an untouched page stays quiet.
 *
 * It only reports and asks. The setting's owner decides what "default" means
 * and how a reset writes — an immediate setter, a draft field that stays
 * unsaved until Save, an inherited `null` — so the comparison lives next to
 * the value, never here.
 */
defineProps<{
	/** The value differs from its default. */
	changed: boolean;
	/** The setting's name, for the button's accessible label. */
	label: string;
	disabled?: boolean;
}>();

const emit = defineEmits<{ reset: [] }>();
const { t } = useI18n();
</script>

<template>
	<span
		v-if="changed"
		class="inline-flex shrink-0 items-center gap-1.5"
		data-testid="setting-reset"
	>
		<span class="size-1.5 rounded-full bg-brand" aria-hidden="true" />
		<button
			type="button"
			class="inline-flex items-center gap-1 rounded text-xs text-text-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50"
			:aria-label="t('components.settings.resetToDefault.resetLabel', { setting: label })"
			:disabled="disabled"
			@click.stop.prevent="emit('reset')"
		>
			<Icon name="lucide:rotate-ccw" class="size-3" aria-hidden="true" />
			{{ t('components.settings.resetToDefault.reset') }}
		</button>
	</span>
</template>
