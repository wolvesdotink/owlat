<script setup lang="ts">
/**
 * Message card beside the `::smtp-session` terminal: fills in From, To,
 * Subject and body as the DATA phase plays, and turns green once the server
 * queues the message.
 */
import { computed } from 'vue';
import { smtpSessionLines as lines } from '../../utils/smtpSession';

const props = defineProps<{
	/** Index of the last transcript line shown; -1 before playback starts. */
	currentLine: number;
}>();

/** Email preview data that builds up during the DATA phase */
const emailPreview = computed(() => {
	const visible = lines.slice(0, props.currentLine + 1);
	const from = visible.find((l) => l.semantic === 'header' && l.text.startsWith('From:'));
	const to = visible.find((l) => l.semantic === 'header' && l.text.startsWith('To:'));
	const subject = visible.find((l) => l.semantic === 'header' && l.text.startsWith('Subject:'));
	const body = visible.find((l) => l.semantic === 'body');
	const queued = visible.find((l) => l.type === 'server' && l.text.includes('queued'));

	if (!from && !to && !subject && !body) return null;

	return {
		from: from ? from.text.replace('From: ', '') : null,
		to: to ? to.text.replace('To: ', '') : null,
		subject: subject ? subject.text.replace('Subject: ', '') : null,
		body: body ? body.text : null,
		queued: !!queued,
	};
});
</script>

<template>
	<div
		class="smtp-preview"
		:class="{
			'smtp-preview--visible': emailPreview,
			'smtp-preview--queued': emailPreview?.queued,
		}"
	>
		<div class="smtp-preview-chrome">
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
				<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
				<polyline points="22,6 12,13 2,6" />
			</svg>
			<span>Received message</span>
			<span v-if="emailPreview?.queued" class="smtp-preview-badge">Delivered</span>
		</div>
		<div class="smtp-preview-body">
			<div v-if="emailPreview?.from" class="smtp-preview-field">
				<span class="smtp-preview-label">From</span>
				<span class="smtp-preview-value">{{ emailPreview.from }}</span>
			</div>
			<div v-if="emailPreview?.to" class="smtp-preview-field">
				<span class="smtp-preview-label">To</span>
				<span class="smtp-preview-value">{{ emailPreview.to }}</span>
			</div>
			<div v-if="emailPreview?.subject" class="smtp-preview-field smtp-preview-field--subject">
				<span class="smtp-preview-label">Subject</span>
				<span class="smtp-preview-value smtp-preview-subject">{{ emailPreview.subject }}</span>
			</div>
			<div v-if="emailPreview?.body" class="smtp-preview-content">
				{{ emailPreview.body }}
			</div>
		</div>
	</div>
</template>

<style scoped>
/* ── Email preview card ── */
.smtp-preview {
	width: 220px;
	flex-shrink: 0;
	border-radius: 10px;
	background: var(--color-bg-surface);
	border: 1px solid var(--color-border-subtle);
	overflow: hidden;
	opacity: 0;
	transform: translateX(10px) scale(0.97);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring),
		border-color var(--motion-slow);
	pointer-events: none;
}

.smtp-preview--visible {
	opacity: 1;
	transform: translateX(0) scale(1);
	pointer-events: auto;
}

.smtp-preview--queued {
	border-color: color-mix(in oklab, var(--color-success) 35%, var(--color-border-subtle));
}

@media (max-width: 700px) {
	.smtp-preview {
		width: 100%;
	}
}

.smtp-preview-chrome {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 8px 12px;
	background: var(--color-bg-elevated);
	border-bottom: 1px solid var(--color-border-subtle);
	font-size: 0.6875rem;
	font-weight: var(--font-weight-medium);
	color: var(--color-text-tertiary);
}

.smtp-preview-badge {
	margin-left: auto;
	padding: 1px 7px;
	border-radius: 9999px;
	font-size: 0.5625rem;
	font-weight: var(--font-weight-semibold);
	font-family: var(--font-mono);
	text-transform: uppercase;
	letter-spacing: 0.04em;
	background: color-mix(in oklab, var(--color-success) 12%, var(--color-bg-surface));
	color: var(--color-success);
	animation: smtp-badge-in 0.4s var(--ease-spring);
}

@keyframes smtp-badge-in {
	from {
		opacity: 0;
		transform: scale(0.8);
	}
	to {
		opacity: 1;
		transform: scale(1);
	}
}

.smtp-preview-body {
	padding: 10px 12px;
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.smtp-preview-field {
	display: flex;
	flex-direction: column;
	gap: 1px;
	animation: smtp-field-in 0.3s ease-out;
}

@keyframes smtp-field-in {
	from {
		opacity: 0;
		transform: translateY(4px);
	}
	to {
		opacity: 1;
		transform: translateY(0);
	}
}

.smtp-preview-label {
	font-size: 0.5625rem;
	font-family: var(--font-mono);
	font-weight: var(--font-weight-semibold);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--color-text-disabled);
}

.smtp-preview-value {
	font-size: 0.75rem;
	color: var(--color-text-secondary);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.smtp-preview-field--subject {
	padding-bottom: 6px;
	border-bottom: 1px solid var(--color-border-subtle);
}

.smtp-preview-subject {
	font-weight: var(--font-weight-semibold);
	color: var(--color-text-primary);
}

.smtp-preview-content {
	font-size: 0.75rem;
	color: var(--color-text-secondary);
	line-height: 1.5;
	font-style: italic;
	animation: smtp-field-in 0.3s ease-out;
}
</style>
