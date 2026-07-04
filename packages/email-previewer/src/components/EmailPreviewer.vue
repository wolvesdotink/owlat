<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
	Code,
	Eye,
	RefreshCw,
	AlertTriangle,
	Send,
	FileText,
	Zap,
	Download,
	Copy,
	Check,
	ChevronDown,
	Settings,
	GitCompare,
	X,
	Sun,
	Moon,
} from '@lucide/vue';
import type {
	EmailClient,
	DevicePreset,
	CompatibilityReport,
	NestingDepthResult,
	PreviewEmailAnalysis,
	PreviewHealthScore,
	PreviewValidationIssue,
	PreviewEmailDiff,
	PreviewRenderOptions,
} from '../types';
import { devicePresets } from '../data/clients';
import { useCompatibilityAnalysis } from '../composables/useCompatibilityAnalysis';
import { applyClientSimulation, type SimulationResult } from '../clientSimulation';
import { formatHtml } from '../formatHtml';
import ClientSelector from './ClientSelector.vue';
import DeviceFrame from './DeviceFrame.vue';
import AnalysisPanel from './AnalysisPanel.vue';
import RenderOptionsPanel from './RenderOptionsPanel.vue';
import DiffPanel from './DiffPanel.vue';

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
		/** Optional nesting depth analysis result to show warning in compatibility panel */
		nestingDepthWarning?: NestingDepthResult | null;
		/** Plain text version of the email */
		plainText?: string;
		/** AMP HTML version of the email */
		ampHtml?: string;
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
		nestingDepthWarning: null,
		plainText: '',
		ampHtml: '',
		renderWarnings: () => [],
		emailAnalysis: null,
		healthScore: null,
		validationIssues: () => [],
		emailDiff: null,
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
const copiedFormat = ref<string | null>(null);

// Compatibility analysis
const { analyzeHtml, report, isAnalyzing } = useCompatibilityAnalysis();

// Computed
const simulationResult = computed<SimulationResult>(() => {
	if (!selectedClient.value || props.useRendererSimulation) {
		return {
			html: props.html,
			removedCssDeclarations: 0,
			removedElements: 0,
			strippedAttributes: 0,
			blockedImages: 0,
		};
	}
	return applyClientSimulation(props.html, selectedClient.value, report.value);
});

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
const hasSimulationAdjustments = computed(
	() =>
		simulationResult.value.removedCssDeclarations > 0 ||
		simulationResult.value.removedElements > 0 ||
		simulationResult.value.strippedAttributes > 0 ||
		simulationResult.value.blockedImages > 0
);

const hasAnalysisData = computed(
	() => props.emailAnalysis || props.healthScore || props.validationIssues?.length
);

const hasWarnings = computed(() => (props.renderWarnings?.length ?? 0) > 0);
const hasDiff = computed(() => props.emailDiff && !props.emailDiff.identical);

function refreshPreview() {
	iframeKey.value++;
	runAnalysis();
}

async function runAnalysis() {
	if (!selectedClient.value) {
		report.value = null;
		return;
	}

	const result = await analyzeHtml(props.html, {
		clients: [selectedClient.value],
	});
	emit('compatibility-report', result);
}

// Export functions
async function copyToClipboard(text: string, format: string) {
	try {
		await navigator.clipboard.writeText(text);
		copiedFormat.value = format;
		setTimeout(() => {
			copiedFormat.value = null;
		}, 2000);
	} catch {
		// Fallback for older browsers
		const textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.style.position = 'fixed';
		textarea.style.opacity = '0';
		document.body.appendChild(textarea);
		textarea.select();
		document.execCommand('copy');
		document.body.removeChild(textarea);
		copiedFormat.value = format;
		setTimeout(() => {
			copiedFormat.value = null;
		}, 2000);
	}
	exportMenuOpen.value = false;
}

function downloadFile(content: string, filename: string, mimeType: string) {
	const blob = new Blob([content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
	exportMenuOpen.value = false;
}

function handleRenderOptionsUpdate(options: Partial<PreviewRenderOptions>) {
	emit('update:render-options', options);
}

// Watch for HTML and selected client changes
watch(
	[() => props.html, selectedClient],
	() => {
		if (props.autoAnalyze) {
			runAnalysis();
		}
	},
	{ immediate: true }
);

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
		<div class="ep-toolbar">
			<div class="ep-toolbar-left">
				<!-- View Mode Toggle -->
				<div v-if="showCodeView" class="ep-view-toggle">
					<button
						class="ep-view-btn"
						:class="{ 'ep-view-active': viewMode === 'preview' }"
						@click="viewMode = 'preview'"
					>
						<Eye class="ep-view-icon" />
						Preview
					</button>
					<button
						class="ep-view-btn"
						:class="{ 'ep-view-active': viewMode === 'code' }"
						@click="viewMode = 'code'"
					>
						<Code class="ep-view-icon" />
						HTML
					</button>
					<button
						class="ep-view-btn"
						:class="{ 'ep-view-active': viewMode === 'plaintext' }"
						@click="viewMode = 'plaintext'"
					>
						<FileText class="ep-view-icon" />
						Text
					</button>
					<button
						v-if="ampHtml"
						class="ep-view-btn"
						:class="{ 'ep-view-active': viewMode === 'amp' }"
						@click="viewMode = 'amp'"
					>
						<Zap class="ep-view-icon" />
						AMP
					</button>
				</div>

				<!-- Client & Device Selectors -->
				<ClientSelector
					v-if="showDeviceControls"
					v-model:selected-client="selectedClient"
					v-model:selected-device="selectedDevice"
				/>
			</div>

			<div class="ep-toolbar-right">
				<!-- Render Warnings Badge -->
				<button
					v-if="hasWarnings"
					class="ep-warning-badge"
					:class="{ 'ep-warning-badge-active': warningsExpanded }"
					title="Render warnings"
					@click="warningsExpanded = !warningsExpanded"
				>
					<AlertTriangle class="ep-warning-badge-icon" />
					<span>{{ renderWarnings!.length }}</span>
				</button>

				<!-- Diff Button -->
				<button
					v-if="hasDiff"
					class="ep-control-btn"
					:class="{ 'ep-control-btn-active': diffPanelOpen }"
					title="Compare changes"
					@click="diffPanelOpen = !diffPanelOpen"
				>
					<GitCompare class="ep-control-icon" />
				</button>

				<!-- Dark Mode Toggle -->
				<button
					class="ep-control-btn"
					:class="{ 'ep-control-btn-active': darkMode }"
					:title="darkMode ? 'Switch to light mode' : 'Switch to dark mode'"
					@click="emit('update:dark-mode', !darkMode)"
				>
					<Moon v-if="!darkMode" class="ep-control-icon" />
					<Sun v-else class="ep-control-icon" />
				</button>

				<!-- Settings Button -->
				<button
					v-if="showRenderOptions"
					class="ep-control-btn"
					:class="{ 'ep-control-btn-active': settingsPanelOpen }"
					title="Render options"
					@click="settingsPanelOpen = !settingsPanelOpen"
				>
					<Settings class="ep-control-icon" />
				</button>

				<!-- Export Dropdown -->
				<div class="ep-export-wrapper">
					<button
						class="ep-control-btn"
						title="Export"
						@click.stop="exportMenuOpen = !exportMenuOpen"
					>
						<Download class="ep-control-icon" />
					</button>
					<div v-if="exportMenuOpen" class="ep-export-menu">
						<button class="ep-export-item" @click="copyToClipboard(html, 'html')">
							<Copy class="ep-export-item-icon" />
							<span>Copy HTML</span>
							<Check v-if="copiedFormat === 'html'" class="ep-export-check" />
						</button>
						<button
							v-if="plainText"
							class="ep-export-item"
							@click="copyToClipboard(plainText, 'text')"
						>
							<Copy class="ep-export-item-icon" />
							<span>Copy Plain Text</span>
							<Check v-if="copiedFormat === 'text'" class="ep-export-check" />
						</button>
						<div class="ep-export-divider"></div>
						<button
							class="ep-export-item"
							@click="downloadFile(html, 'email.html', 'text/html')"
						>
							<Download class="ep-export-item-icon" />
							<span>Download .html</span>
						</button>
						<button
							v-if="plainText"
							class="ep-export-item"
							@click="downloadFile(plainText, 'email.txt', 'text/plain')"
						>
							<Download class="ep-export-item-icon" />
							<span>Download .txt</span>
						</button>
						<button
							v-if="ampHtml"
							class="ep-export-item"
							@click="downloadFile(ampHtml, 'email.amp.html', 'text/html')"
						>
							<Download class="ep-export-item-icon" />
							<span>Download .amp.html</span>
						</button>
					</div>
				</div>

				<div v-if="showSendTest" class="ep-toolbar-divider"></div>

				<button
					v-if="showSendTest"
					class="ep-action-btn ep-action-primary"
					title="Send test email"
					@click="emit('send-test')"
				>
					<Send class="ep-action-icon" />
					<span>Send Test</span>
				</button>

				<div class="ep-toolbar-divider"></div>

				<!-- Refresh -->
				<button class="ep-control-btn" title="Refresh preview" @click="refreshPreview">
					<RefreshCw class="ep-control-icon" />
				</button>
			</div>
		</div>

		<!-- Render Warnings Expanded -->
		<div v-if="hasWarnings && warningsExpanded" class="ep-warnings-panel">
			<div class="ep-warnings-header">
				<span class="ep-warnings-title">
					<AlertTriangle class="ep-warnings-title-icon" />
					{{ renderWarnings!.length }} Render Warning{{ renderWarnings!.length === 1 ? '' : 's' }}
				</span>
				<button class="ep-warnings-close" @click="warningsExpanded = false">
					<X class="ep-warnings-close-icon" />
				</button>
			</div>
			<ul class="ep-warnings-list">
				<li v-for="(warning, idx) in renderWarnings" :key="idx" class="ep-warnings-item">
					{{ warning }}
				</li>
			</ul>
		</div>

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
							title="Email preview"
						></iframe>
					</DeviceFrame>
				</div>

				<!-- Client Info Banner -->
				<div v-if="selectedClient" class="ep-client-banner">
					<span class="ep-client-banner-text">
						Previewing as <strong>{{ selectedClient.name }}</strong>
						<template v-if="selectedClient.renderingEngine">
							({{ selectedClient.renderingEngine }} engine)
						</template>
					</span>
					<div class="ep-simulation-note">
						<AlertTriangle class="ep-simulation-icon" />
						<span>
							Simulated rendering only. This preview may not be 100% accurate in real inboxes.
							<template v-if="hasSimulationAdjustments">
								Removed {{ simulationResult.removedCssDeclarations }} style declaration{{
									simulationResult.removedCssDeclarations === 1 ? '' : 's'
								}}
								and {{ simulationResult.removedElements }} unsupported element{{
									simulationResult.removedElements === 1 ? '' : 's'
								}},
								stripped {{ simulationResult.strippedAttributes }} class/id attribute{{
									simulationResult.strippedAttributes === 1 ? '' : 's'
								}},
								blocked {{ simulationResult.blockedImages }} remote image{{
									simulationResult.blockedImages === 1 ? '' : 's'
								}}.
							</template>
						</span>
					</div>
					<span v-if="selectedClient.quirks?.length" class="ep-client-quirks">
						Known quirks: {{ selectedClient.quirks.join(', ') }}
					</span>
				</div>
			</div>

			<!-- Code Mode -->
			<div v-else-if="viewMode === 'code'" class="ep-code-area">
				<pre class="ep-code-block"><code>{{ formattedHtml }}</code></pre>
			</div>

			<!-- Plain Text Mode -->
			<div v-else-if="viewMode === 'plaintext'" class="ep-code-area">
				<pre class="ep-code-block ep-plaintext-block">{{ plainText || 'No plain text generated.' }}</pre>
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
							title="AMP email preview"
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
				:nesting-depth-warning="nestingDepthWarning"
				:is-analyzing="isAnalyzing"
				:expanded="compatibilityExpanded"
				@toggle="compatibilityExpanded = !compatibilityExpanded"
			/>
		</div>

		<!-- Subject/Preheader Preview -->
		<div v-if="subject || preheader" class="ep-meta-preview">
			<div v-if="subject" class="ep-meta-item">
				<span class="ep-meta-label">Subject</span>
				<span class="ep-meta-value">{{ subject }}</span>
			</div>
			<div v-if="preheader" class="ep-meta-item">
				<span class="ep-meta-label">Preheader</span>
				<span class="ep-meta-value ep-meta-preheader">{{ preheader }}</span>
			</div>
		</div>
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

/* Toolbar */
.ep-toolbar {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 16px;
	padding: 12px 16px;
	background: var(--ep-bg-elevated);
	border-bottom: 1px solid var(--ep-border-subtle);
}

.ep-toolbar-left,
.ep-toolbar-right {
	display: flex;
	align-items: center;
	gap: 8px;
}

.ep-toolbar-divider {
	width: 1px;
	height: 24px;
	background: var(--ep-border-subtle);
}

/* View Toggle */
.ep-view-toggle {
	display: flex;
	background: var(--ep-bg-surface);
	border-radius: 8px;
	padding: 2px;
}

.ep-view-btn {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 12px;
	background: transparent;
	border: none;
	border-radius: 6px;
	color: var(--ep-text-secondary);
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
	transition: all var(--motion-fast, 80ms) var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-view-btn:hover {
	color: var(--ep-text-primary);
}

.ep-view-active {
	background: var(--ep-bg-elevated);
	color: var(--ep-text-primary);
	box-shadow: var(--ep-shadow-sm);
}

.ep-view-icon {
	width: 14px;
	height: 14px;
}

.ep-control-btn {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	background: transparent;
	border: none;
	border-radius: 6px;
	color: var(--ep-text-tertiary);
	cursor: pointer;
	transition: all var(--motion-fast, 80ms) var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-control-btn:hover:not(:disabled) {
	background: var(--ep-bg-surface);
	color: var(--ep-text-secondary);
}

.ep-control-btn:disabled {
	opacity: 0.4;
	cursor: not-allowed;
}

.ep-control-btn-active {
	background: var(--ep-bg-surface);
	color: var(--ep-brand);
}

.ep-control-icon {
	width: 16px;
	height: 16px;
}

.ep-action-btn {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 8px 12px;
	border-radius: 8px;
	border: 1px solid transparent;
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
	transition: filter var(--motion-fast, 80ms) var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-action-primary {
	background: var(--ep-brand);
	color: var(--ep-text-inverse);
}

.ep-action-primary:hover {
	filter: brightness(1.06);
}

.ep-action-icon {
	width: 14px;
	height: 14px;
}

/* Warning Badge */
.ep-warning-badge {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 4px 10px;
	background: var(--ep-warning-subtle);
	border: 1px solid var(--ep-warning);
	border-radius: 12px;
	color: var(--ep-warning);
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
	transition: all var(--motion-fast, 80ms) var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-warning-badge:hover,
.ep-warning-badge-active {
	background: var(--ep-warning);
	color: var(--ep-text-inverse);
}

.ep-warning-badge-icon {
	width: 12px;
	height: 12px;
}

/* Warnings Panel */
.ep-warnings-panel {
	background: var(--ep-warning-subtle);
	border-bottom: 1px solid var(--ep-border-subtle);
	padding: 12px 16px;
}

.ep-warnings-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin-bottom: 8px;
}

.ep-warnings-title {
	display: flex;
	align-items: center;
	gap: 6px;
	font-size: 12px;
	font-weight: 600;
	color: var(--ep-warning);
}

.ep-warnings-title-icon {
	width: 14px;
	height: 14px;
}

.ep-warnings-close {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 24px;
	height: 24px;
	background: transparent;
	border: none;
	border-radius: 4px;
	color: var(--ep-text-tertiary);
	cursor: pointer;
}

.ep-warnings-close:hover {
	background: var(--ep-bg-surface);
	color: var(--ep-text-primary);
}

.ep-warnings-close-icon {
	width: 14px;
	height: 14px;
}

.ep-warnings-list {
	margin: 0;
	padding: 0 0 0 20px;
	list-style: disc;
}

.ep-warnings-item {
	font-size: 12px;
	line-height: 1.5;
	color: var(--ep-text-secondary);
	padding: 2px 0;
}

/* Export Dropdown */
.ep-export-wrapper {
	position: relative;
}

.ep-export-menu {
	position: absolute;
	top: 100%;
	right: 0;
	margin-top: 4px;
	min-width: 200px;
	background: var(--ep-bg-elevated);
	border: 1px solid var(--ep-border-default);
	border-radius: 8px;
	box-shadow: var(--ep-shadow-lg);
	padding: 4px;
	z-index: 50;
}

.ep-export-item {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	padding: 8px 12px;
	background: transparent;
	border: none;
	border-radius: 6px;
	color: var(--ep-text-secondary);
	font-size: 13px;
	cursor: pointer;
	transition: all var(--motion-fast, 80ms) var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
}

.ep-export-item:hover {
	background: var(--ep-bg-surface);
	color: var(--ep-text-primary);
}

.ep-export-item-icon {
	width: 14px;
	height: 14px;
	flex-shrink: 0;
}

.ep-export-check {
	width: 14px;
	height: 14px;
	color: var(--ep-success);
	margin-left: auto;
}

.ep-export-divider {
	height: 1px;
	background: var(--ep-border-subtle);
	margin: 4px 0;
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

/* Client Banner */
.ep-client-banner {
	display: flex;
	flex-direction: column;
	gap: 4px;
	padding: 10px 16px;
	background: var(--ep-bg-surface);
	border-top: 1px solid var(--ep-border-subtle);
}

.ep-client-banner-text {
	font-size: 12px;
	color: var(--ep-text-secondary);
}

.ep-client-banner-text strong {
	color: var(--ep-text-primary);
}

.ep-simulation-note {
	display: flex;
	align-items: flex-start;
	gap: 6px;
	padding: 8px 10px;
	border-radius: 8px;
	background: var(--ep-warning-subtle);
	color: var(--ep-warning);
	font-size: 11px;
	line-height: 1.4;
}

.ep-simulation-icon {
	width: 13px;
	height: 13px;
	flex-shrink: 0;
	margin-top: 1px;
}

.ep-client-quirks {
	font-size: 11px;
	color: var(--ep-text-tertiary);
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

/* Meta Preview */
.ep-meta-preview {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 12px 16px;
	background: var(--ep-bg-elevated);
	border-top: 1px solid var(--ep-border-subtle);
}

.ep-meta-item {
	display: flex;
	align-items: baseline;
	gap: 12px;
}

.ep-meta-label {
	flex-shrink: 0;
	font-size: 11px;
	font-weight: 600;
	color: var(--ep-text-tertiary);
	text-transform: uppercase;
	letter-spacing: 0.05em;
}

.ep-meta-value {
	font-size: 13px;
	color: var(--ep-text-primary);
}

.ep-meta-preheader {
	color: var(--ep-text-secondary);
	font-style: italic;
}
</style>
