<script setup lang="ts">
import UiTooltip from '@owlat/ui/components/ui/Tooltip.vue';
import {
	CodeIcon,
	DownloadIcon,
	EyeIcon,
	FileTextIcon,
	GitCompareIcon,
	MoonIcon,
	PaperPlaneIcon,
	ReloadIcon,
	SettingsIcon,
	SunIcon,
	TriangleWarningIcon,
	ZapIcon,
} from '@coolicons/vue';
import type { EmailClient, DevicePreset } from '../../types';
import { useEmailExport } from '../../composables/useEmailExport';
import ClientSelector from '../ClientSelector.vue';
import PreviewExportMenu from './PreviewExportMenu.vue';
import { useBuilderI18n } from '../../../i18n/useBuilderI18n';

const { t } = useBuilderI18n();

defineProps<{
	html: string;
	/** The plain text the Text view shows; empty when there is none. */
	plainText: string;
	ampHtml: string;
	ampAvailable: boolean;
	showCodeView: boolean;
	showDeviceControls: boolean;
	renderWarnings: string[];
	hasWarnings: boolean;
	hasDiff: boolean;
	darkMode: boolean;
	showRenderOptions: boolean;
	showSendTest: boolean;
}>();

const emit = defineEmits<{
	(e: 'update:dark-mode', value: boolean): void;
	(e: 'send-test'): void;
	(e: 'refresh'): void;
}>();

// The previewer owns these: they decide what it renders below the toolbar and
// what it asks its host for.
const viewMode = defineModel<'preview' | 'code' | 'plaintext' | 'amp'>('viewMode', {
	required: true,
});
const selectedClient = defineModel<EmailClient | null>('selectedClient', { required: true });
const selectedDevice = defineModel<DevicePreset>('selectedDevice', { required: true });
const warningsExpanded = defineModel<boolean>('warningsExpanded', { required: true });
const diffPanelOpen = defineModel<boolean>('diffPanelOpen', { required: true });
const settingsPanelOpen = defineModel<boolean>('settingsPanelOpen', { required: true });
const exportMenuOpen = defineModel<boolean>('exportMenuOpen', { required: true });

const { copiedFormat, copyToClipboard, downloadFile } = useEmailExport(() => {
	exportMenuOpen.value = false;
});
</script>

<template>
	<div class="ep-toolbar">
		<div class="ep-toolbar-left">
			<!-- View Mode Toggle -->
			<div v-if="showCodeView" class="ep-view-toggle" role="group">
				<button
					type="button"
					class="ep-view-btn"
					:class="{ 'ep-view-active': viewMode === 'preview' }"
					:aria-pressed="viewMode === 'preview'"
					@click="viewMode = 'preview'"
				>
					<EyeIcon class="ep-view-icon" aria-hidden="true" />
					{{ t('builder.preview.views.preview') }}
				</button>
				<button
					type="button"
					class="ep-view-btn"
					:class="{ 'ep-view-active': viewMode === 'code' }"
					:aria-pressed="viewMode === 'code'"
					@click="viewMode = 'code'"
				>
					<CodeIcon class="ep-view-icon" aria-hidden="true" />
					HTML
				</button>
				<button
					type="button"
					class="ep-view-btn"
					:class="{ 'ep-view-active': viewMode === 'plaintext' }"
					:aria-pressed="viewMode === 'plaintext'"
					@click="viewMode = 'plaintext'"
				>
					<FileTextIcon class="ep-view-icon" aria-hidden="true" />
					{{ t('builder.preview.views.text') }}
				</button>
				<button
					v-if="ampHtml || ampAvailable"
					type="button"
					class="ep-view-btn"
					:class="{ 'ep-view-active': viewMode === 'amp' }"
					:aria-pressed="viewMode === 'amp'"
					@click="viewMode = 'amp'"
				>
					<ZapIcon class="ep-view-icon" aria-hidden="true" />
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
			<!-- Render Warnings Badge: an icon and a count, so the name is spelled out -->
			<UiTooltip v-if="hasWarnings" :text="t('builder.preview.toolbar.renderWarnings')">
				<button
					type="button"
					class="ep-warning-badge"
					:class="{ 'ep-warning-badge-active': warningsExpanded }"
					:aria-expanded="warningsExpanded"
					:aria-label="`${t('builder.preview.toolbar.renderWarnings')}: ${renderWarnings.length}`"
					@click="warningsExpanded = !warningsExpanded"
				>
					<TriangleWarningIcon class="ep-warning-badge-icon" aria-hidden="true" />
					<span>{{ renderWarnings.length }}</span>
				</button>
			</UiTooltip>

			<!-- Diff Button -->
			<UiTooltip v-if="hasDiff" :text="t('builder.preview.toolbar.compare')">
				<button
					type="button"
					class="ep-control-btn"
					:class="{ 'ep-control-btn-active': diffPanelOpen }"
					:aria-pressed="diffPanelOpen"
					:aria-label="t('builder.preview.toolbar.compare')"
					@click="diffPanelOpen = !diffPanelOpen"
				>
					<GitCompareIcon class="ep-control-icon" />
				</button>
			</UiTooltip>

			<!-- Dark Mode Toggle -->
			<UiTooltip
				:text="
					darkMode ? t('builder.preview.toolbar.lightMode') : t('builder.preview.toolbar.darkMode')
				"
			>
				<button
					type="button"
					class="ep-control-btn"
					:class="{ 'ep-control-btn-active': darkMode }"
					:aria-pressed="darkMode"
					:aria-label="
						darkMode
							? t('builder.preview.toolbar.lightMode')
							: t('builder.preview.toolbar.darkMode')
					"
					@click="emit('update:dark-mode', !darkMode)"
				>
					<MoonIcon v-if="!darkMode" class="ep-control-icon" />
					<SunIcon v-else class="ep-control-icon" />
				</button>
			</UiTooltip>

			<!-- Settings Button -->
			<UiTooltip v-if="showRenderOptions" :text="t('builder.preview.toolbar.renderOptions')">
				<button
					type="button"
					class="ep-control-btn"
					:class="{ 'ep-control-btn-active': settingsPanelOpen }"
					:aria-pressed="settingsPanelOpen"
					:aria-label="t('builder.preview.toolbar.renderOptions')"
					@click="settingsPanelOpen = !settingsPanelOpen"
				>
					<SettingsIcon class="ep-control-icon" />
				</button>
			</UiTooltip>

			<!-- Export Dropdown -->
			<div class="ep-export-wrapper">
				<UiTooltip :text="t('builder.preview.toolbar.export')">
					<button
						type="button"
						class="ep-control-btn"
						:aria-label="t('builder.preview.toolbar.export')"
						aria-haspopup="menu"
						:aria-expanded="exportMenuOpen"
						@click.stop="exportMenuOpen = !exportMenuOpen"
					>
						<DownloadIcon class="ep-control-icon" />
					</button>
				</UiTooltip>
				<PreviewExportMenu
					v-if="exportMenuOpen"
					:html="html"
					:plain-text="plainText"
					:amp-html="ampHtml"
					:copied-format="copiedFormat"
					@copy="copyToClipboard"
					@download="downloadFile"
				/>
			</div>

			<div v-if="showSendTest" class="ep-toolbar-divider"></div>

			<UiTooltip v-if="showSendTest" :text="t('builder.preview.toolbar.sendTestTitle')">
				<button type="button" class="ep-action-btn ep-action-primary" @click="emit('send-test')">
					<PaperPlaneIcon class="ep-action-icon" aria-hidden="true" />
					<span>{{ t('builder.preview.toolbar.sendTest') }}</span>
				</button>
			</UiTooltip>

			<div class="ep-toolbar-divider"></div>

			<!-- Refresh -->
			<UiTooltip :text="t('builder.preview.toolbar.refresh')">
				<button
					type="button"
					class="ep-control-btn"
					:aria-label="t('builder.preview.toolbar.refresh')"
					@click="emit('refresh')"
				>
					<ReloadIcon class="ep-control-icon" />
				</button>
			</UiTooltip>
		</div>
	</div>
</template>

<style scoped>
/* Toolbar */
.ep-toolbar {
	display: flex;
	/* Wraps: with the app sidebar open on a 1024-1280px screen the two groups
	   are wider than the previewer, which clips its overflow, and Send test and
	   Refresh fell off the end. */
	flex-wrap: wrap;
	justify-content: space-between;
	align-items: center;
	gap: 8px 16px;
	padding: 12px 16px;
	background: var(--ep-bg-elevated);
	border-bottom: 1px solid var(--ep-border-subtle);
}

.ep-toolbar-left,
.ep-toolbar-right {
	display: flex;
	flex-wrap: wrap;
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
	transition-property: color, background-color, box-shadow;
	transition-duration: var(--motion-fast, 80ms);
	transition-timing-function: var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
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
	transition-property: color, background-color, opacity;
	transition-duration: var(--motion-fast, 80ms);
	transition-timing-function: var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
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

/* Monochrome, like .btn-primary: inverse text on brand terracotta is ~3.8:1
   in light mode, below AA for a 13px label, and brand is kept for accents. */
.ep-action-primary {
	background: var(--ep-text-primary);
	color: var(--ep-text-inverse);
}

.ep-action-primary:hover {
	opacity: 0.85;
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
	transition-property: color, background-color;
	transition-duration: var(--motion-fast, 80ms);
	transition-timing-function: var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1));
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

/* Export Dropdown */
.ep-export-wrapper {
	position: relative;
}
</style>
