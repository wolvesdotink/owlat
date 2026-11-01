<script setup lang="ts">
/**
 * A password field with a show/hide toggle, for every screen where someone
 * types an account password (sign-in, register, reset, desktop sign-in, the
 * two-factor password prompts, the setup wizard's admin step).
 *
 * It mirrors `UiInput`'s markup and classes rather than wrapping it: the
 * toggle has to be a real, focusable button inside the input's box, and
 * `UiInput`'s icon slots are decorative (`aria-hidden`, no pointer events).
 * Label, error and help text are wired to the input the same way `UiInput`
 * does, so the accessibility contract of the auth forms does not change.
 *
 * The toggle keeps one name ("Show password") and reports its state through
 * `aria-pressed`, so a screen reader hears "Show password, pressed" instead of
 * a label that flips between two opposite sentences.
 */
import { EyeIcon, EyeOffIcon } from '@coolicons/vue';

interface Props {
	modelValue?: string;
	label?: string;
	placeholder?: string;
	autocomplete?: string;
	error?: string;
	helpText?: string;
	id?: string;
	required?: boolean;
	disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	modelValue: '',
	required: false,
	disabled: false,
});

const emit = defineEmits<{
	'update:modelValue': [value: string];
	blur: [event: FocusEvent];
}>();

const { t } = useI18n();

const revealed = ref(false);

const generatedId = useId();
const inputId = computed(() => props.id || generatedId);

const describedBy = computed(() => {
	const ids: string[] = [];
	if (props.error) ids.push(`${inputId.value}-error`);
	else if (props.helpText) ids.push(`${inputId.value}-help`);
	return ids.length ? ids.join(' ') : undefined;
});

function onInput(event: Event) {
	emit('update:modelValue', (event.target as HTMLInputElement).value);
}
</script>

<template>
	<div>
		<label v-if="label" :for="inputId" class="block text-sm font-medium text-text-secondary mb-2">
			{{ label }}
			<span v-if="required" class="text-error">*</span>
		</label>

		<div class="relative">
			<input
				:id="inputId"
				:type="revealed ? 'text' : 'password'"
				:value="modelValue"
				:placeholder="placeholder"
				:autocomplete="autocomplete"
				:disabled="disabled"
				:required="required"
				:aria-required="required || undefined"
				:aria-invalid="error ? true : undefined"
				:aria-describedby="describedBy"
				autocapitalize="off"
				spellcheck="false"
				class="input pr-10"
				:class="error ? 'input-error' : ''"
				@input="onInput"
				@blur="emit('blur', $event)"
			/>
			<button
				type="button"
				class="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-text-tertiary hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
				:aria-label="t('auth.fields.showPassword')"
				:aria-pressed="revealed"
				:aria-controls="inputId"
				:disabled="disabled"
				data-testid="password-visibility-toggle"
				@click="revealed = !revealed"
			>
				<component :is="revealed ? EyeOffIcon : EyeIcon" class="size-4" />
			</button>
		</div>

		<p v-if="error" :id="`${inputId}-error`" class="text-sm text-error mt-1">{{ error }}</p>
		<p v-else-if="helpText" :id="`${inputId}-help`" class="text-sm text-text-tertiary mt-1">
			{{ helpText }}
		</p>
	</div>
</template>
