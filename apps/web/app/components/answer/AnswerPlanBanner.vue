<script setup lang="ts">
/**
 * "One thing before sending" (plan §6): the draft says a file is attached that
 * is not. It names the claim in the draft's own words and offers to pick the
 * file; it never holds Send. The host attaches what was picked (the Postbox
 * composer, or the team reply's attachments) and checks the draft again.
 */
const props = defineProps<{
	/** The draft's words for each file it says is attached and is not. */
	claims: readonly string[];
	canAttach: boolean;
}>();

const emit = defineEmits<{ files: [files: File[]] }>();

const { t } = useI18n();
const input = ref<HTMLInputElement | null>(null);

function onPicked(event: Event) {
	const target = event.target as HTMLInputElement;
	const files = [...(target.files ?? [])];
	target.value = '';
	if (files.length > 0) emit('files', files);
}
</script>

<template>
	<div
		v-if="props.claims.length > 0"
		role="status"
		class="mx-3 mt-3 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-text-primary"
		data-testid="answer-plan-file-claim"
	>
		<p class="min-w-0 flex-1">
			<strong class="font-medium">{{ t('components.answer.plan.banner.title') }}</strong>
			{{ t('components.answer.plan.banner.body', { claim: props.claims[0] }) }}
		</p>
		<template v-if="canAttach">
			<input ref="input" type="file" multiple class="hidden" @change="onPicked" />
			<UiButton
				size="sm"
				variant="ghost"
				data-testid="answer-plan-pick-file"
				@click="input?.click()"
			>
				{{ t('components.answer.plan.banner.pick') }}
			</UiButton>
		</template>
	</div>
</template>
