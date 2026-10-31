<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue';
// The --ep-* fallbacks load with the previewer, not with every host page.
import '../styles/variables.css';
import type {
	EmailClient,
	DevicePreset,
	CompatibilityReport,
	PreviewEmailAnalysis,
	PreviewHealthScore,
	PreviewValidationIssue,
	PreviewEmailDiff,
	PreviewRenderOptions,
} from '../types';
import { devicePresets } from '../data/clients';
import { useClientPreview } from '../composables/useClientPreview';
import { usePlainTextOverride } from '../composables/usePlainTextOverride';
import { formatHtml } from '../formatHtml';
import DeviceFrame from './DeviceFrame.vue';
import { AnalysisPanel, RenderOptionsPanel, DiffPanel } from './lazyPanels';
import PreviewToolbar from './previewer/PreviewToolbar.vue';
import PreviewWarningsPanel from './previewer/PreviewWarningsPanel.vue';
import PreviewClientBanner from './previewer/PreviewClientBanner.vue';
import PreviewMeta from './previewer/PreviewMeta.vue';
import { useBuilderI18n } from '../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

const props = withDefaults(
	defineProps<{
		html: string;
		subject?: string;
		preheader?: string;
		showCompatibility?: boolean;
		showDeviceControls?: boolean;
		showCodeView?: boolean;
		defaultDevice?: string;
		autoAnalyze?: boolean;
		showSendTest?: boolean;
		/** Plain text version of the email (generated from the block document) */
		plainText?: string;
		/**
		 * The generated plain text WITHOUT preview variable substitution — what a
		 * new manual override is seeded from, so `{{firstName}}` tokens survive
		 * into the stored body instead of being frozen at a preview value.
		 */
		plainTextSource?: string;
		/** The author's manual text/plain body; empty string when none is stored. */
		plainTextOverride?: string;
		/** Whether the host persists a manual plain-text override. */
		allowPlainTextOverride?: boolean;
		/** AMP HTML version of the email */
		ampHtml?: string;
		/**
		 * The host renders AMP on request: show the AMP view even while `ampHtml`
		 * is still empty, and listen to `update:amp-requested`.
		 */
		ampAvailable?: boolean;
		/** Render warnings from the renderer */
		renderWarnings?: string[];
		/** Email size/quality analysis */
		emailAnalysis?: PreviewEmailAnalysis | null;
		/** Email health score with sub-scores */
		healthScore?: PreviewHealthScore | null;
		/** Block validation issues */
		validationIssues?: PreviewValidationIssue[];
		/** Email diff from previous version */
		emailDiff?: PreviewEmailDiff | null;
		/**
		 * The host diffs on request: the HTML changed since the previous render, so
		 * offer the diff while `emailDiff` is still null, and listen to
		 * `update:diff-requested`.
		 */
		diffAvailable?: boolean;
		/** Current render options */
		renderOptions?: Partial<PreviewRenderOptions>;
		/** Whether to show render options gear icon */
		showRenderOptions?: boolean;
		/** Skip previewer DOM-based simulation when renderer targetClient was used */
		useRendererSimulation?: boolean;
		/** Whether dark mode preview is active */
		darkMode?: boolean;
	}>(),
	{
		subject: '',
		preheader: '',
		showCompatibility: true,
		showDeviceControls: true,
		showCodeView: true,
		defaultDevice: 'desktop',
		autoAnalyze: true,
		showSendTest: false,
		plainText: '',
		plainTextSource: '',
		plainTextOverride: '',
		allowPlainTextOverride: false,
		ampHtml: '',
		ampAvailable: false,
		renderWarnings: () => [],
		emailAnalysis: null,
		healthScore: null,
		validationIssues: () => [],
		emailDiff: null,
		diffAvailable: false,
		renderOptions: undefined,
		showRenderOptions: true,
		useRendererSimulation: false,
		darkMode: false,
	}
);

const emit = defineEmits<{
	(e: 'compatibility-report', report: CompatibilityReport): void;
	(e: 'send-test'): void;
	(e: 'update:render-options', options: Partial<PreviewRenderOptions>): void;
	(e: 'update:dark-mode', value: boolean): void;
	(e: 'update:plain-text-override', value: string): void;
	(e: 'update:amp-requested', value: boolean): void;
	(e: 'update:diff-requested', value: boolean): void;
}>();

// State
const selectedClient = ref<EmailClient | null>(null);
const selectedDevice = ref<DevicePreset>(
	devicePresets.find((d) => d.id === props.defaultDevice) ?? devicePresets[0]!
);
const viewMode = ref<'preview' | 'code' | 'plaintext' | 'amp'>('preview');
const compatibilityExpanded = ref(false);
const iframeKey = ref(0);
const warningsExpanded = ref(false);
const exportMenuOpen = ref(false);
const settingsPanelOpen = ref(false);
const diffPanelOpen = ref(false);

// The selected client's rendering and its compatibility analysis
const { report, isAnalyzing, analysisError, simulationResult, runAnalysis } = useClientPreview(
	props,
	selectedClient,
	(result) => emit('compatibility-report', result)
);

const displayHtml = computed(() => {
	return simulationResult.value.html;
});

const formattedHtml = computed(() => {
	try {
		return formatHtml(props.html);
	} catch {
		return props.html;
	}
});

const showCompatibilityPanel = computed(
	() => props.showCompatibility && viewMode.value === 'preview' && !!selectedClient.value
);
const hasAnalysisData = computed(
	() => props.emailAnalysis || props.healthScore || props.validationIssues?.length
);

// The Text view's manual plain-text body
const {
	plainTextDraft,
	isEditingPlainText,
	plainTextStatus,
	displayPlainText,
	startPlainTextOverride,
	updatePlainTextOverride,
	resetPlainTextOverride,
} = usePlainTextOverride(props, (value) => emit('update:plain-text-override', value));

// AMP is only needed by the AMP view and the export menu; tell the host when,
// so it does not render AMP for every preview.
const ampNeeded = computed(() => viewMode.value === 'amp' || exportMenuOpen.value);
watch(ampNeeded, (needed) => emit('update:amp-requested', needed));
onBeforeUnmount(() => {
	if (ampNeeded.value) emit('update:amp-requested', false);
});

const hasWarnings = computed(() => (props.renderWarnings?.length ?? 0) > 0);
const hasDiff = computed(
	() => props.diffAvailable || (!!props.emailDiff && !props.emailDiff.identical)
);

// Only the diff panel reads the diff; tell the host while it is open.
watch(diffPanelOpen, (open) => emit('update:diff-requested', open));
onBeforeUnmount(() => {
	if (diffPanelOpen.value) emit('update:diff-requested', false);
});

function refreshPreview() {
	iframeKey.value++;
	runAnalysis();
}

function handleRenderOptionsUpdate(options: Partial<PreviewRenderOptions>) {
	emit('update:render-options', options);
}

// Close export menu on click outside
function handleClickOutside(event: MouseEvent) {
	const target = event.target as HTMLElement;
	if (!target.closest('.ep-export-wrapper')) {
		exportMenuOpen.value = false;
	}
}
</script>

<template>
	<div class="ep-email-previewer" @click="handleClickOutside">
		<!-- Toolbar -->
		<PreviewToolbar
			v-model:view-mode="viewMode"
			v-model:selected-client="selectedClient"
			v-model:selected-device="selectedDevice"
			v-model:warnings-expanded="warningsExpanded"
			v-model:diff-panel-open="diffPanelOpen"
			v-model:settings-panel-open="settingsPanelOpen"
			v-model:export-menu-open="exportMenuOpen"
			:html="html"
			:plain-text="displayPlainText"
			:amp-html="ampHtml"
			:amp-available="ampAvailable"
			:show-code-view="showCodeView"
			:show-device-controls="showDeviceControls"
			:render-warnings="renderWarnings"
			:has-warnings="hasWarnings"
			:has-diff="hasDiff"
			:dark-mode="darkMode"
			:show-render-options="showRenderOptions"
			:show-send-test="showSendTest"
			@update:dark-mode="emit('update:dark-mode', $event)"
			@send-test="emit('send-test')"
			@refresh="refreshPreview"
		/>

		<!-- Render Warnings Expanded -->
		<PreviewWarningsPanel
			v-if="hasWarnings && warningsExpanded"
			:render-warnings="renderWarnings"
			@close="warningsExpanded = false"
		/>

		<!-- Settings Panel -->
		<RenderOptionsPanel
			v-if="settingsPanelOpen"
			:options="renderOptions ?? {}"
			@update:options="handleRenderOptionsUpdate"
			@close="settingsPanelOpen = false"
		/>

		<!-- Diff Panel -->
		<DiffPanel
			v-if="diffPanelOpen && emailDiff"
			:email-diff="emailDiff"
			@close="diffPanelOpen = false"
		/>

		<!-- Content Area -->
		<div class="ep-content">
			<!-- Preview Mode -->
			<div v-if="viewMode === 'preview'" class="ep-preview-area">
				<div class="ep-preview-scroll">
					<DeviceFrame :device="selectedDevice">
						<iframe
							:key="iframeKey"
							:srcdoc="displayHtml"
							class="ep-preview-iframe"
							sandbox="allow-same-origin"
							:title="t('builder.preview.frame.email')"
						></iframe>
					</DeviceFrame>
				</div>

				<!-- Client Info Banner -->
				<PreviewClientBanner
					v-if="selectedClient"
					:selected-client="selectedClient"
					:simulation-result="simulationResult"
				/>
			</div>

			<!-- Code Mode -->
			<div v-else-if="viewMode === 'code'" class="ep-code-area">
				<pre class="ep-code-block"><code>{{ formattedHtml }}</code></pre>
			</div>

			<!-- Plain Text Mode -->
			<div v-else-if="viewMode === 'plaintext'" class="ep-code-area">
				<div v-if="allowPlainTextOverride" class="ep-plaintext-bar">
					<span class="ep-plaintext-status">
						{{ plainTextStatus }}
					</span>
					<button
						v-if="!isEditingPlainText"
						class="ep-plaintext-action"
						@click="startPlainTextOverride"
					>
						{{ t('builder.preview.plainText.edit') }}
					</button>
					<button v-else class="ep-plaintext-action" @click="resetPlainTextOverride">
						{{ t('builder.preview.plainText.useGenerated') }}
					</button>
				</div>
				<textarea
					v-if="allowPlainTextOverride && isEditingPlainText"
					:value="plainTextDraft"
					class="ep-code-block ep-plaintext-block ep-plaintext-editor"
					spellcheck="false"
					:aria-label="t('builder.preview.plainText.body')"
					@input="updatePlainTextOverride(($event.target as HTMLTextAreaElement).value)"
				></textarea>
				<pre v-else class="ep-code-block ep-plaintext-block">{{
					displayPlainText || t('builder.preview.plainText.none')
				}}</pre>
			</div>

			<!-- AMP Mode -->
			<div v-else-if="viewMode === 'amp'" class="ep-preview-area">
				<div class="ep-preview-scroll">
					<DeviceFrame :device="selectedDevice">
						<iframe
							:key="iframeKey"
							:srcdoc="ampHtml"
							class="ep-preview-iframe"
							sandbox="allow-same-origin"
							:title="t('builder.preview.frame.amp')"
						></iframe>
					</DeviceFrame>
				</div>
			</div>

			<!-- Analysis Panel (replaces standalone CompatibilityPanel) -->
			<AnalysisPanel
				v-if="hasAnalysisData || showCompatibilityPanel"
				:email-analysis="emailAnalysis ?? null"
				:health-score="healthScore ?? null"
				:validation-issues="validationIssues ?? []"
				:compatibility-report="report"
				:compatibility-error="analysisError?.message ?? null"
				:selected-client-name="selectedClient?.name ?? null"
				:is-analyzing="isAnalyzing"
				:expanded="compatibilityExpanded"
				@toggle="compatibilityExpanded = !compatibilityExpanded"
			/>
		</div>

		<!-- Subject/Preheader Preview -->
		<PreviewMeta v-if="subject || preheader" :subject="subject" :preheader="preheader" />
	</div>
</template>

<style scoped>
.ep-email-previewer {
	display: flex;
	flex-direction: column;
	height: 100%;
	background: var(--ep-bg-base);
	border: 1px solid var(--ep-border-default);
	border-radius: 12px;
	overflow: hidden;
}

/* Content Area */
.ep-content {
	flex: 1;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

/* Preview Area */
.ep-preview-area {
	flex: 1;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

.ep-preview-scroll {
	flex: 1;
	overflow: auto;
	padding: 24px;
	background: var(--ep-bg-deep);
	background-image: radial-gradient(circle at 1px 1px, var(--ep-border-subtle) 1px, transparent 0);
	background-size: 20px 20px;
}

.ep-preview-iframe {
	width: 100%;
	height: 100%;
	border: none;
	background: #ffffff;
	color-scheme: light only;
}

/* Code Area */
.ep-code-area {
	flex: 1;
	overflow: auto;
	padding: 16px;
	background: var(--ep-bg-deep);
}

.ep-code-block {
	margin: 0;
	padding: 16px;
	background: var(--ep-bg-surface);
	border: 1px solid var(--ep-border-subtle);
	border-radius: 8px;
	font-family: var(--ep-font-mono);
	font-size: 12px;
	line-height: 1.6;
	color: var(--ep-text-primary);
	overflow-x: auto;
	white-space: pre;
}

.ep-plaintext-block {
	white-space: pre-wrap;
	word-wrap: break-word;
}

.ep-plaintext-bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	margin-bottom: 8px;
}

.ep-plaintext-status {
	font-size: 12px;
	color: var(--ep-text-secondary);
}

.ep-plaintext-action {
	padding: 4px 10px;
	border: 1px solid var(--ep-border-subtle);
	border-radius: 6px;
	background: var(--ep-bg-surface);
	color: var(--ep-text-primary);
	font-size: 12px;
	cursor: pointer;
}

.ep-plaintext-action:hover {
	background: var(--ep-bg-elevated);
}

.ep-plaintext-editor {
	display: block;
	width: 100%;
	min-height: 320px;
	resize: vertical;
}
</style>
