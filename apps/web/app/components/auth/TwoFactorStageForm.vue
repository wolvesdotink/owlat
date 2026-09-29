<script setup lang="ts">
/**
 * The second stage of a password sign-in: the account has TOTP enabled, the
 * password was accepted, and the server is holding the session behind a
 * short-lived challenge cookie until a code arrives.
 *
 * Shared by the web sign-in page and the desktop connect handshake. It is the
 * same question asked by the same product, so it is one form: fixes to it
 * (focus, paste handling, error copy) land on both surfaces at once. The state
 * comes from `useTwoFactorChallenge`, which the page owns because the page also
 * decides when the challenge starts.
 */
import type { TwoFactorChallenge } from '~/composables/useTwoFactorChallenge';

interface Props {
	challenge: TwoFactorChallenge;
	isLoading?: boolean;
	/** The last failed attempt, shown on the code field. */
	errorMessage?: string;
	/** The desktop connect card is smaller than the sign-in shell. */
	compact?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	isLoading: false,
	errorMessage: '',
	compact: false,
});

const emit = defineEmits<{
	submit: [];
	cancel: [];
}>();

const { t } = useI18n();

const code = computed(() => props.challenge.code.value);
const useBackupCode = computed(() => props.challenge.useBackupCode.value);
const canSubmit = computed(() => props.challenge.canSubmit.value);

function onSubmit() {
	if (!canSubmit.value || props.isLoading) return;
	emit('submit');
}
</script>

<template>
	<form :class="compact ? 'space-y-4' : 'space-y-5'" @submit.prevent="onSubmit">
		<div>
			<h2 :class="compact ? 'text-sm font-medium' : 'font-medium'">
				{{ t('auth.login.twoFactor.title') }}
			</h2>
			<p class="text-sm text-text-secondary mt-1">
				{{ useBackupCode ? t('auth.login.twoFactor.backupBody') : t('auth.login.twoFactor.body') }}
			</p>
		</div>

		<UiInput
			id="two-factor-code"
			:model-value="code"
			:autocomplete="useBackupCode ? 'off' : 'one-time-code'"
			:label="
				useBackupCode ? t('auth.login.twoFactor.backupLabel') : t('auth.login.twoFactor.codeLabel')
			"
			:error="errorMessage"
			:size="compact ? 'sm' : 'md'"
			autofocus
			@update:model-value="(value: string | number) => challenge.onCodeInput(String(value))"
		/>

		<UiButton
			type="submit"
			:size="compact ? 'md' : 'lg'"
			full-width
			:loading="isLoading"
			:disabled="!canSubmit"
		>
			{{ isLoading ? t('auth.login.twoFactor.submitting') : t('auth.login.twoFactor.submit') }}
		</UiButton>

		<div class="flex items-center justify-between text-sm">
			<button type="button" class="link" @click="challenge.switchMethod()">
				{{
					useBackupCode
						? t('auth.login.twoFactor.useAuthenticator')
						: t('auth.login.twoFactor.useBackupCode')
				}}
			</button>
			<button type="button" class="link" @click="emit('cancel')">
				{{ t('auth.login.twoFactor.cancel') }}
			</button>
		</div>
	</form>
</template>
