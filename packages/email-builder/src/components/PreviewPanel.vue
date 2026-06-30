<script setup lang="ts">
import { Loader2 } from '@lucide/vue';
import { EmailPreviewer } from '@owlat/email-previewer';
import type {
	PreviewEmailAnalysis,
	PreviewHealthScore,
	PreviewValidationIssue,
	PreviewEmailDiff,
	PreviewRenderOptions,
} from '@owlat/email-previewer';

const props = defineProps<{
	html: string;
	subject?: string;
	isGenerating?: boolean;
	plainText?: string;
	ampHtml?: string;
	renderWarnings?: string[];
	emailAnalysis?: PreviewEmailAnalysis | null;
	healthScore?: PreviewHealthScore | null;
	validationIssues?: PreviewValidationIssue[];
	emailDiff?: PreviewEmailDiff | null;
	renderOptions?: Partial<PreviewRenderOptions>;
	darkMode?: boolean;
}>();

const emit = defineEmits<{
	(e: 'send-test'): void;
	(e: 'update:render-options', options: Partial<PreviewRenderOptions>): void;
	(e: 'update:dark-mode', value: boolean): void;
}>();
</script>

<template>
	<div class="flex flex-col h-full bg-bg-deep">
		<div v-if="props.isGenerating" class="flex items-center justify-center gap-2 flex-1 text-text-secondary text-sm">
			<Loader2 class="w-[18px] h-[18px] animate-spin" />
			<span>Generating preview...</span>
		</div>

		<EmailPreviewer
			v-else
			:html="props.html"
			:subject="props.subject"
			:plain-text="props.plainText"
			:amp-html="props.ampHtml"
			:render-warnings="props.renderWarnings"
			:email-analysis="props.emailAnalysis"
			:health-score="props.healthScore"
			:validation-issues="props.validationIssues"
			:email-diff="props.emailDiff"
			:render-options="props.renderOptions"
			:dark-mode="props.darkMode"
			:show-compatibility="true"
			:show-device-controls="true"
			:show-code-view="true"
			:auto-analyze="true"
			:show-send-test="true"
			:show-render-options="true"
			class="flex-1 min-h-0"
			@send-test="emit('send-test')"
			@update:render-options="emit('update:render-options', $event)"
			@update:dark-mode="emit('update:dark-mode', $event)"
		/>
	</div>
</template>
