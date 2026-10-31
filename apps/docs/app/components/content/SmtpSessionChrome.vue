<script setup lang="ts">
/**
 * Title bar of the `::smtp-session` terminal: the server address (with a lock
 * once the TLS handshake line has played) and the replay / skip controls.
 */
import { computed } from 'vue';
import { smtpSessionLines as lines } from '../../utils/smtpSession';

const props = defineProps<{
	/** Index of the last transcript line shown; -1 before playback starts. */
	currentLine: number;
	isPlaying: boolean;
	hasPlayed: boolean;
}>();

const emit = defineEmits<{
	play: [];
	showAll: [];
}>();

/** Whether TLS handshake annotation is currently showing or has shown */
const tlsActive = computed(() => {
	const tlsIdx = lines.findIndex((l) => l.type === 'annotation');
	return tlsIdx >= 0 && props.currentLine >= tlsIdx;
});
</script>

<template>
	<div class="smtp-chrome">
		<div class="smtp-dots"><span /><span /><span /></div>
		<span class="smtp-title">
			<svg
				v-if="tlsActive"
				class="smtp-lock"
				width="10"
				height="10"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
				<path d="M7 11V7a5 5 0 0110 0v4" />
			</svg>
			mx.example.com:25
		</span>
		<div class="smtp-controls">
			<UiTooltip v-if="hasPlayed" text="Replay">
				<button class="smtp-btn" aria-label="Replay" @click="emit('play')">
					<svg
						width="12"
						height="12"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<polyline points="1 4 1 10 7 10" />
						<path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
					</svg>
				</button>
			</UiTooltip>
			<UiTooltip v-if="isPlaying" text="Skip to end">
				<button class="smtp-btn" aria-label="Skip to end" @click="emit('showAll')">
					<svg
						width="12"
						height="12"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<polygon points="5 4 15 12 5 20 5 4" />
						<line x1="19" y1="5" x2="19" y2="19" />
					</svg>
				</button>
			</UiTooltip>
		</div>
	</div>
</template>

<style scoped>
.smtp-chrome {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 8px 14px;
	background: var(--color-bg-surface);
	border-bottom: 1px solid var(--color-border-subtle);
}

.smtp-dots {
	display: flex;
	gap: 5px;
}

.smtp-dots span {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: var(--color-border-default);
	opacity: 0.5;
}

.smtp-title {
	flex: 1;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 5px;
	font-size: 0.6875rem;
	font-family: var(--font-mono);
	color: var(--color-text-tertiary);
}

.smtp-lock {
	color: var(--color-success);
	animation: smtp-lock-in 0.4s var(--ease-spring);
}

@keyframes smtp-lock-in {
	from {
		opacity: 0;
		transform: scale(0.5);
	}
	to {
		opacity: 1;
		transform: scale(1);
	}
}

.smtp-controls {
	display: flex;
	gap: 4px;
	min-width: 28px;
}

.smtp-btn {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 24px;
	height: 24px;
	border: none;
	border-radius: 6px;
	background: transparent;
	color: var(--color-text-tertiary);
	cursor: pointer;
	transition:
		background var(--motion-moderate),
		color var(--motion-moderate);
}

.smtp-btn:hover {
	background: var(--color-bg-elevated);
	color: var(--color-text-primary);
}
</style>
