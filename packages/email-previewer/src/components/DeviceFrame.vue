<script setup lang="ts">
import { computed } from 'vue';
import type { DevicePreset } from '../types';

const props = defineProps<{
	device: DevicePreset;
	darkMode?: boolean;
	zoom?: number;
}>();

const frameStyles = computed(() => {
	const scale = props.zoom ?? 1;
	return {
		width: `${props.device.width}px`,
		height: `${props.device.height}px`,
		transform: `scale(${scale})`,
		transformOrigin: 'top center',
	};
});

const containerStyles = computed(() => {
	const scale = props.zoom ?? 1;
	return {
		width: `${props.device.width * scale}px`,
		height: `${props.device.height * scale}px`,
	};
});

const isMobile = computed(() => props.device.type === 'mobile');
const isTablet = computed(() => props.device.type === 'tablet');
</script>

<template>
	<div class="ep-device-container" :style="containerStyles">
		<div
			class="ep-device-frame"
			:class="{
				'ep-device-mobile': isMobile,
				'ep-device-tablet': isTablet,
				'ep-device-dark': darkMode,
			}"
			:style="frameStyles"
		>
			<!-- Mobile notch -->
			<div v-if="isMobile" class="ep-device-notch">
				<div class="ep-device-notch-inner">
					<div class="ep-device-camera"></div>
					<div class="ep-device-speaker"></div>
				</div>
			</div>

			<!-- Status bar for mobile -->
			<div v-if="isMobile" class="ep-device-statusbar">
				<span class="ep-statusbar-time">9:41</span>
				<div class="ep-statusbar-icons">
					<svg class="ep-statusbar-icon" viewBox="0 0 24 24" fill="currentColor">
						<path
							d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3a4.237 4.237 0 0 0-6 0zm-4-4l2 2a7.074 7.074 0 0 1 10 0l2-2C15.14 9.14 8.87 9.14 5 13z"
						/>
					</svg>
					<svg class="ep-statusbar-icon" viewBox="0 0 24 24" fill="currentColor">
						<path d="M2 22h20V2z" />
					</svg>
					<div class="ep-statusbar-battery">
						<div class="ep-battery-fill"></div>
					</div>
				</div>
			</div>

			<!-- Content area -->
			<div class="ep-device-content">
				<slot></slot>
			</div>

			<!-- Home indicator for mobile -->
			<div v-if="isMobile" class="ep-device-home-indicator">
				<div class="ep-home-bar"></div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.ep-device-container {
	display: flex;
	justify-content: center;
	margin: 0 auto;
}

.ep-device-frame {
	position: relative;
	display: flex;
	flex-direction: column;
	background: var(--ep-bg-surface);
	border: 1px solid var(--ep-border-default);
	overflow: hidden;
	transition: all 0.3s ease;
}

/* Desktop frame */
.ep-device-frame:not(.ep-device-mobile):not(.ep-device-tablet) {
	border-radius: 8px;
	box-shadow: var(--ep-shadow-lg);
}

/* Tablet frame */
.ep-device-tablet {
	border-radius: 24px;
	border-width: 12px;
	border-color: var(--ep-bg-overlay);
	box-shadow:
		var(--ep-shadow-lg),
		inset 0 0 0 2px var(--ep-border-subtle);
}

/* Mobile frame */
.ep-device-mobile {
	border-radius: 44px;
	border-width: 12px;
	border-color: var(--ep-bg-overlay);
	box-shadow:
		var(--ep-shadow-lg),
		inset 0 0 0 2px var(--ep-border-subtle);
}

.ep-device-dark .ep-device-content {
	background: #1a1a1a;
}

/* Notch */
.ep-device-notch {
	position: absolute;
	top: 0;
	left: 50%;
	transform: translateX(-50%);
	width: 126px;
	height: 34px;
	background: var(--ep-bg-overlay);
	border-radius: 0 0 24px 24px;
	z-index: 10;
	display: flex;
	align-items: center;
	justify-content: center;
}

.ep-device-notch-inner {
	display: flex;
	align-items: center;
	gap: 8px;
}

.ep-device-camera {
	width: 12px;
	height: 12px;
	background: var(--ep-bg-deep);
	border-radius: 50%;
	border: 2px solid var(--ep-border-strong);
}

.ep-device-speaker {
	width: 40px;
	height: 6px;
	background: var(--ep-bg-deep);
	border-radius: 3px;
}

/* Status bar */
.ep-device-statusbar {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 14px 24px 8px;
	font-size: 14px;
	font-weight: 600;
	color: var(--ep-text-primary);
	background: var(--ep-bg-surface);
}

.ep-statusbar-time {
	font-variant-numeric: tabular-nums;
}

.ep-statusbar-icons {
	display: flex;
	align-items: center;
	gap: 4px;
}

.ep-statusbar-icon {
	width: 16px;
	height: 16px;
}

.ep-statusbar-battery {
	width: 24px;
	height: 11px;
	border: 1.5px solid currentColor;
	border-radius: 3px;
	padding: 1px;
	position: relative;
}

.ep-statusbar-battery::after {
	content: '';
	position: absolute;
	right: -4px;
	top: 50%;
	transform: translateY(-50%);
	width: 2px;
	height: 5px;
	background: currentColor;
	border-radius: 0 1px 1px 0;
}

.ep-battery-fill {
	width: 80%;
	height: 100%;
	background: currentColor;
	border-radius: 1px;
}

/* Content area */
.ep-device-content {
	flex: 1;
	overflow: auto;
	background: #ffffff;
}

/* Home indicator */
.ep-device-home-indicator {
	display: flex;
	justify-content: center;
	padding: 8px 0 4px;
	background: var(--ep-bg-surface);
}

.ep-home-bar {
	width: 134px;
	height: 5px;
	background: var(--ep-text-tertiary);
	border-radius: 3px;
}
</style>
