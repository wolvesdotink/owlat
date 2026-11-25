<script setup lang="ts">
/**
 * Names the `{{tokens}}` in a subject or preview text that no variable of the
 * email defines (the send renders them empty) and offers to define each one.
 */
import { TriangleWarningIcon } from '@coolicons/vue';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

defineProps<{ id: string; keys: string[] }>();

const emit = defineEmits<{
	(e: 'add-variable', key: string): void;
}>();

const token = (key: string) => `{{${key}}}`;
</script>

<template>
	<div :id="id" class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-warning">
		<TriangleWarningIcon :size="12" class="shrink-0" />
		<span>
			<template v-for="(key, index) in keys" :key="key">
				<span v-if="index > 0">, </span>
				<code class="font-mono">{{ token(key) }}</code>
			</template>
			{{ t('builder.subject.unknownVariables', { count: keys.length }) }}
		</span>
		<button
			v-for="key in keys"
			:key="`define-${key}`"
			type="button"
			class="rounded px-1 font-medium text-text-secondary underline underline-offset-2 hover:text-text-primary"
			@click="emit('add-variable', key)"
		>
			{{ t('builder.subject.define', { key }) }}
		</button>
	</div>
</template>
