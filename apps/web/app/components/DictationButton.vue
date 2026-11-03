<script setup lang="ts">
/**
 * The microphone beside a text field: press to dictate, press again to stop,
 * Esc to cancel. Finished phrases go in at the field's caret (`target`); the
 * phrase still being heard shows in a bubble, with who hears the audio.
 *
 * Rendered only where a speech engine is there to use (`useSpeechDictation`),
 * so no browser shows a mic that cannot work. `mousedown.prevent` keeps the
 * field's caret and focus where they were when the mic is clicked.
 *
 * "Listening" goes to the app's live region (`useAnnounce`) rather than one of
 * its own: a region mounted with its message is usually not read.
 */
import { useEscapeLayer } from '@owlat/ui/composables/useEscapeLayer';
import { useToast } from '@owlat/ui/composables/useToast';
import { useAnnounce } from '~/composables/useAnnounce';
import { useSpeechDictation, type DictationError } from '~/composables/useSpeechDictation';
import { insertDictated, type DictationTarget } from '~/utils/dictation';

const props = withDefaults(
	defineProps<{
		/** Where phrases go; nothing renders without one. */
		target: DictationTarget | null | undefined;
		/** `above`: the bubble opens up from the button's left edge; `below`: down from its right. */
		bubble?: 'above' | 'below';
		size?: 'sm' | 'md';
		disabled?: boolean;
	}>(),
	{ bubble: 'above', size: 'md', disabled: false }
);

const { t } = useI18n();
const { announce } = useAnnounce();
const { showToast } = useToast();

const dictation = useSpeechDictation({
	onPhrase: (phrase) => {
		if (props.target) insertDictated(props.target, phrase);
	},
});
const { available, onDevice, listening, interim, error } = dictation;

function toggle() {
	if (listening.value) dictation.stop();
	else dictation.start();
}

// Esc cancels, as the innermost layer, so it does not also close the composer.
useEscapeLayer(listening, () => dictation.cancel());

// The field going away (an editor mode switch, a busy bar) ends listening.
watch(
	() => !props.target || props.disabled,
	(gone) => {
		if (gone) dictation.cancel();
	}
);

watch(listening, (on) =>
	announce(
		on
			? t('components.dictationButton.listeningAnnouncement')
			: t('components.dictationButton.stoppedAnnouncement')
	)
);

const ERROR_KEYS: Record<DictationError, string> = {
	blocked: 'components.dictationButton.errors.blocked',
	'no-speech': 'components.dictationButton.errors.noSpeech',
	network: 'components.dictationButton.errors.network',
	language: 'components.dictationButton.errors.language',
	failed: 'components.dictationButton.errors.failed',
};
watch(error, (reason) => {
	if (!reason) return;
	showToast(t(ERROR_KEYS[reason]), reason === 'no-speech' ? 'info' : 'error');
	error.value = null;
});

// Who turns speech into text: on this device, or the browser's service (the
// desktop app offers only the first). On the button for everyone, and in the
// bubble while listening.
const privacyNote = computed(() =>
	onDevice.value
		? t('components.dictationButton.privacy.onDevice')
		: t('components.dictationButton.privacy.browser')
);

const noteId = useId();
const label = computed(() => t('components.dictationButton.label'));
</script>

<template>
	<span v-if="available && target" class="relative inline-flex shrink-0">
		<UiTooltip
			:text="
				listening
					? t('components.dictationButton.stopTooltip')
					: t('components.dictationButton.label')
			"
		>
			<UiButton
				variant="ghost"
				:size="size"
				type="button"
				:class="['relative', { 'text-error': listening }]"
				:disabled="disabled"
				:aria-label="label"
				:aria-pressed="listening"
				:aria-describedby="noteId"
				data-testid="dictation-button"
				@mousedown.prevent
				@click="toggle"
			>
				<Icon name="lucide:mic" class="size-4" aria-hidden="true" />
				<span
					v-if="listening"
					class="absolute right-1 top-1 size-1.5 rounded-full bg-error animate-pulse motion-reduce:animate-none"
					aria-hidden="true"
				/>
			</UiButton>
		</UiTooltip>
		<span :id="noteId" class="sr-only">{{ privacyNote }}</span>
		<!-- Seen while listening; screen readers get the same from the live region
		     and the button's description, so this stays out of their way. -->
		<span
			v-if="listening"
			class="absolute z-30 w-64 rounded-md border border-border-subtle bg-bg-elevated px-3 py-2 text-xs shadow-md"
			:class="bubble === 'above' ? 'bottom-full left-0 mb-2' : 'top-full right-0 mt-2'"
			aria-hidden="true"
			data-testid="dictation-bubble"
		>
			<span class="flex items-center gap-1.5 font-medium text-text-primary">
				<span class="size-1.5 rounded-full bg-error animate-pulse motion-reduce:animate-none" />{{
					t('components.dictationButton.listening')
				}}
			</span>
			<span
				v-if="interim"
				class="mt-1 block italic text-text-secondary"
				data-testid="dictation-interim"
			>
				{{ interim }}
			</span>
			<span class="mt-1 block text-text-tertiary">{{ privacyNote }}</span>
			<span class="mt-1 block text-text-tertiary">{{
				t('components.dictationButton.escHint')
			}}</span>
		</span>
	</span>
</template>
