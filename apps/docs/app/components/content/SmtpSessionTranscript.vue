<script setup lang="ts">
/**
 * Body of the `::smtp-session` terminal: every transcript line up to
 * `currentLine`, rendered by kind (server reply, client command, DATA header /
 * body / terminator, TLS annotation, blank, phase separator). The newest line
 * animates in and carries the cursor while the replay is playing.
 */
import {
	parseClientCommand,
	parseHeader,
	parseServerText,
	smtpSessionLines as lines,
} from '../../utils/smtpSession';

defineProps<{
	/** Index of the last transcript line shown; -1 before playback starts. */
	currentLine: number;
	isPlaying: boolean;
}>();
</script>

<template>
	<div class="smtp-body">
		<!-- Cursor blinking before anything appears -->
		<div v-if="currentLine < 0 && isPlaying" class="smtp-line smtp-line--cursor">
			<span class="smtp-cursor" />
		</div>

		<template v-for="(line, i) in lines" :key="i">
			<!-- Phase separator -->
			<div v-if="line.type === 'phase-sep' && i <= currentLine" class="smtp-sep" />

			<!-- Server line -->
			<div
				v-else-if="line.type === 'server' && i <= currentLine"
				class="smtp-line smtp-line--server"
				:class="{ 'smtp-line--latest': i === currentLine && isPlaying }"
			>
				<span class="smtp-prefix smtp-prefix--server">S</span>
				<span class="smtp-text">
					<span class="smtp-code smtp-code--server">{{ parseServerText(line.text).code }}</span>
					<span class="smtp-rest smtp-rest--server">{{ parseServerText(line.text).rest }}</span>
				</span>
				<span v-if="i === currentLine && isPlaying" class="smtp-cursor" />
			</div>

			<!-- Client line: command -->
			<div
				v-else-if="line.type === 'client' && line.semantic === 'command' && i <= currentLine"
				class="smtp-line smtp-line--client"
				:class="{ 'smtp-line--latest': i === currentLine && isPlaying }"
			>
				<span class="smtp-prefix smtp-prefix--client">C</span>
				<span class="smtp-text">
					<template v-if="parseClientCommand(line.text)">
						<span class="smtp-keyword">{{ parseClientCommand(line.text)!.keyword }}</span>
						<span class="smtp-args">{{ parseClientCommand(line.text)!.args }}</span>
					</template>
					<span v-else class="smtp-rest smtp-rest--client">{{ line.text }}</span>
				</span>
				<span v-if="i === currentLine && isPlaying" class="smtp-cursor" />
			</div>

			<!-- Client line: header -->
			<div
				v-else-if="line.type === 'client' && line.semantic === 'header' && i <= currentLine"
				class="smtp-line smtp-line--client smtp-line--header"
				:class="{ 'smtp-line--latest': i === currentLine && isPlaying }"
			>
				<span class="smtp-prefix smtp-prefix--client">C</span>
				<span class="smtp-text">
					<span class="smtp-header-key">{{ parseHeader(line.text)?.key }}</span>
					<span class="smtp-header-val">{{ parseHeader(line.text)?.value }}</span>
				</span>
				<span v-if="i === currentLine && isPlaying" class="smtp-cursor" />
			</div>

			<!-- Client line: body -->
			<div
				v-else-if="line.type === 'client' && line.semantic === 'body' && i <= currentLine"
				class="smtp-line smtp-line--client smtp-line--body"
				:class="{ 'smtp-line--latest': i === currentLine && isPlaying }"
			>
				<span class="smtp-prefix smtp-prefix--client">C</span>
				<span class="smtp-text smtp-body-text">{{ line.text }}</span>
				<span v-if="i === currentLine && isPlaying" class="smtp-cursor" />
			</div>

			<!-- Client line: terminator (.) -->
			<div
				v-else-if="line.type === 'client' && line.semantic === 'terminator' && i <= currentLine"
				class="smtp-line smtp-line--client smtp-line--terminator"
				:class="{ 'smtp-line--latest': i === currentLine && isPlaying }"
			>
				<span class="smtp-prefix smtp-prefix--client">C</span>
				<span class="smtp-text smtp-terminator">{{ line.text }}</span>
				<span v-if="i === currentLine && isPlaying" class="smtp-cursor" />
			</div>

			<!-- Annotation (TLS) -->
			<div
				v-else-if="line.type === 'annotation' && i <= currentLine"
				class="smtp-line smtp-line--annotation"
				:class="{ 'smtp-line--latest': i === currentLine && isPlaying }"
			>
				<div class="smtp-tls-banner">
					<svg
						class="smtp-tls-icon"
						width="12"
						height="12"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
						<path d="M7 11V7a5 5 0 0110 0v4" />
					</svg>
					<span>{{ line.text }}</span>
				</div>
			</div>

			<!-- Blank line -->
			<div v-else-if="line.type === 'blank' && i <= currentLine" class="smtp-line smtp-line--blank">
				<span class="smtp-prefix">&nbsp;</span>
			</div>
		</template>
	</div>
</template>

<style scoped>
/* ── Terminal body — FIXED HEIGHT to prevent layout shift ── */
.smtp-body {
	padding: 12px 16px;
	font-family: var(--font-mono);
	font-size: 0.75rem;
	line-height: 1.75;
	/* 27 visible lines × 1.75 line-height × 0.75rem ≈ reserving space for all lines + separators */
	height: calc(31 * 1.75em + 24px);
	overflow-y: auto;
	overflow-x: hidden;
}

/* ── Lines ── */
.smtp-line {
	display: flex;
	align-items: baseline;
	white-space: nowrap;
}

.smtp-line--latest {
	animation: smtp-line-in 0.18s ease-out;
}

@keyframes smtp-line-in {
	from {
		opacity: 0;
		transform: translateX(-6px);
	}
	to {
		opacity: 1;
		transform: translateX(0);
	}
}

/* ── Phase separator ── */
.smtp-sep {
	height: 1px;
	margin: 6px 0;
	background: var(--color-border-subtle);
	opacity: 0.5;
	animation: smtp-sep-in 0.3s ease-out;
}

@keyframes smtp-sep-in {
	from {
		opacity: 0;
		transform: scaleX(0);
	}
	to {
		opacity: 0.5;
		transform: scaleX(1);
	}
}

/* ── Prefix (S / C) ── */
.smtp-prefix {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 18px;
	height: 18px;
	flex-shrink: 0;
	font-weight: 700;
	font-size: 0.625rem;
	border-radius: 4px;
	margin-right: 8px;
	user-select: none;
	line-height: 1;
	position: relative;
	top: 1px;
}

.smtp-prefix--server {
	background: color-mix(in oklab, var(--color-info) 12%, var(--color-bg-deep));
	color: var(--color-info);
	border: 1px solid color-mix(in oklab, var(--color-info) 20%, transparent);
}

.smtp-prefix--client {
	background: color-mix(in oklab, var(--color-brand) 12%, var(--color-bg-deep));
	color: var(--color-brand);
	border: 1px solid color-mix(in oklab, var(--color-brand) 20%, transparent);
}

/* ── Server text: status code highlighted ── */
.smtp-code {
	font-weight: 700;
}

.smtp-code--server {
	color: var(--color-info);
}

.smtp-rest--server {
	color: color-mix(in oklab, var(--color-info) 50%, var(--color-text-tertiary));
}

/* ── Client command text ── */
.smtp-keyword {
	font-weight: 700;
	color: var(--color-brand);
}

.smtp-args {
	color: var(--color-text-secondary);
}

/* ── Header lines (From:, To:, Subject:, Date:) ── */
.smtp-line--header {
	padding-left: 4px;
	border-left: 2px solid color-mix(in oklab, var(--color-accent) 30%, transparent);
	margin-left: 0;
}

.smtp-header-key {
	color: var(--color-accent);
	font-weight: var(--font-weight-semibold);
}

.smtp-header-val {
	color: var(--color-text-primary);
}

/* ── Body text ── */
.smtp-line--body {
	padding-left: 4px;
	border-left: 2px solid color-mix(in oklab, var(--color-success) 25%, transparent);
}

.smtp-body-text {
	color: var(--color-text-primary);
	font-family: var(--font-sans);
	font-style: italic;
}

/* ── Terminator (.) ── */
.smtp-terminator {
	color: var(--color-text-disabled);
	font-weight: 700;
}

/* ── TLS annotation banner ── */
.smtp-tls-banner {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 4px 12px;
	margin: 4px 0;
	border-radius: 6px;
	background: color-mix(in oklab, var(--color-warning) 8%, var(--color-bg-deep));
	border: 1px solid color-mix(in oklab, var(--color-warning) 20%, transparent);
	color: var(--color-warning);
	font-size: 0.6875rem;
	font-style: italic;
}

.smtp-line--annotation.smtp-line--latest .smtp-tls-banner {
	animation: smtp-tls 1s ease-out;
}

@keyframes smtp-tls {
	0% {
		opacity: 0;
		transform: scaleX(0.8);
	}
	100% {
		opacity: 1;
		transform: scaleX(1);
	}
}

.smtp-tls-icon {
	flex-shrink: 0;
	animation: smtp-tls-lock 0.6s var(--ease-spring) 0.3s both;
}

@keyframes smtp-tls-lock {
	from {
		opacity: 0;
		transform: translateY(2px);
	}
	to {
		opacity: 1;
		transform: translateY(0);
	}
}

/* ── Blinking cursor ── */
.smtp-cursor {
	display: inline-block;
	width: 6px;
	height: 13px;
	margin-left: 2px;
	background: var(--color-brand);
	border-radius: 1px;
	animation: smtp-blink 0.8s steps(2) infinite;
	vertical-align: text-bottom;
}

@keyframes smtp-blink {
	0% {
		opacity: 1;
	}
	50% {
		opacity: 0;
	}
}

.smtp-line--cursor {
	height: 1.75em;
}

.smtp-line--blank {
	height: 1.75em;
}
</style>
