<script setup lang="ts">
/**
 * `::smtp-session` — the "How email works" replay of one SMTP conversation,
 * line by line, once the diagram scrolls into view.
 *
 * This component owns the playback: the current line, the per-line delays and
 * the replay / skip controls. The phase bar is `SmtpSessionPhases`, the
 * terminal is `SmtpSessionChrome` + `SmtpSessionTranscript`, the message card
 * is `SmtpSessionPreview`, and the transcript lives in `app/utils/smtpSession`.
 */
import { ref, onMounted, onUnmounted } from 'vue';
import { smtpSessionLines as lines } from '../../utils/smtpSession';

const target = ref<HTMLElement | null>(null);
const isVisible = ref(false);
const currentLine = ref(-1);
const isPlaying = ref(false);
const hasPlayed = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

function showNextLine() {
	if (currentLine.value >= lines.length - 1) {
		isPlaying.value = false;
		hasPlayed.value = true;
		return;
	}
	currentLine.value++;
	const nextLine = lines[currentLine.value + 1];
	if (nextLine) {
		timer = setTimeout(showNextLine, nextLine.delay);
	} else {
		isPlaying.value = false;
		hasPlayed.value = true;
	}
}

function play() {
	if (isPlaying.value) return;
	currentLine.value = -1;
	isPlaying.value = true;
	hasPlayed.value = false;
	timer = setTimeout(showNextLine, lines[0]?.delay ?? 0);
}

function showAll() {
	if (timer) clearTimeout(timer);
	currentLine.value = lines.length - 1;
	isPlaying.value = false;
	hasPlayed.value = true;
}

onMounted(() => {
	if (!target.value) return;
	const observer = new IntersectionObserver(
		(entries) => {
			if (entries[0]?.isIntersecting) {
				isVisible.value = true;
				observer.disconnect();
				setTimeout(play, 400);
			}
		},
		{ threshold: 0.15 }
	);
	observer.observe(target.value);
	onUnmounted(() => {
		observer.disconnect();
		if (timer) clearTimeout(timer);
	});
});
</script>

<template>
	<div ref="target" class="smtp" :class="{ 'is-visible': isVisible }">
		<!-- Phase progress bar -->
		<SmtpSessionPhases :current-line="currentLine" />

		<div class="smtp-layout">
			<!-- Terminal window -->
			<div class="smtp-terminal">
				<SmtpSessionChrome
					:current-line="currentLine"
					:is-playing="isPlaying"
					:has-played="hasPlayed"
					@play="play"
					@show-all="showAll"
				/>
				<SmtpSessionTranscript :current-line="currentLine" :is-playing="isPlaying" />
			</div>

			<!-- Email preview card that builds during DATA phase -->
			<SmtpSessionPreview :current-line="currentLine" />
		</div>
	</div>
</template>

<style scoped>
.smtp {
	margin: 2rem 0;
	opacity: 0;
	transform: translateY(12px);
	transition:
		opacity 0.6s var(--ease-spring),
		transform 0.6s var(--ease-spring);
}

.smtp.is-visible {
	opacity: 1;
	transform: translateY(0);
}

/* ── Layout: terminal + preview side-by-side ── */
.smtp-layout {
	display: flex;
	gap: 14px;
	align-items: flex-start;
}

@media (max-width: 700px) {
	.smtp-layout {
		flex-direction: column;
	}
}

/* ── Terminal window ── */
.smtp-terminal {
	flex: 1;
	min-width: 0;
	border-radius: 10px;
	overflow: hidden;
	background: var(--color-bg-deep);
	border: 1px solid var(--color-border-subtle);
}
</style>
