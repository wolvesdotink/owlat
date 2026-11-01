<script setup lang="ts">
import { MIN_PASSWORD_LENGTH } from '@owlat/shared/passwordPolicy';
import { passwordChangeProblem } from '~/utils/passwordChange';
import { useLocalized } from '~/composables/useLocalized';
import { authClient } from '~/lib/auth-client';

const { t } = useI18n();
const localized = useLocalized();
const { showToast } = useToast();

// ── Change password ──
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const savingPassword = ref(false);
async function changePassword() {
	const problem = passwordChangeProblem(newPassword.value, confirmPassword.value);
	if (problem) {
		showToast(localized(problem), 'error');
		return;
	}
	savingPassword.value = true;
	try {
		const res = await authClient.changePassword({
			currentPassword: currentPassword.value,
			newPassword: newPassword.value,
		});
		if (res.error) {
			showToast(
				res.error.message ?? t('dashboard.preferences.account.passwordChangeFailed'),
				'error'
			);
			return;
		}
		showToast(t('dashboard.preferences.account.passwordChanged'));
		currentPassword.value = '';
		newPassword.value = '';
		confirmPassword.value = '';
	} catch {
		showToast(t('dashboard.preferences.account.passwordChangeFailed'), 'error');
	} finally {
		savingPassword.value = false;
	}
}
</script>

<template>
	<div class="card">
		<h2 class="text-lg font-semibold text-text-primary mb-1">
			{{ t('dashboard.preferences.account.changePasswordTitle') }}
		</h2>
		<p class="text-sm text-text-secondary mb-4">
			{{ t('dashboard.preferences.account.changePasswordDescription') }}
		</p>
		<form class="space-y-3 max-w-md" @submit.prevent="changePassword">
			<AuthPasswordInput
				id="cur-pw"
				v-model="currentPassword"
				:label="t('dashboard.preferences.account.currentPasswordLabel')"
				autocomplete="current-password"
			/>
			<AuthPasswordInput
				id="new-pw"
				v-model="newPassword"
				:label="t('dashboard.preferences.account.newPasswordLabel')"
				:help-text="t('auth.fields.passwordHelp', { min: MIN_PASSWORD_LENGTH })"
				autocomplete="new-password"
			/>
			<AuthPasswordInput
				id="confirm-pw"
				v-model="confirmPassword"
				:label="t('dashboard.preferences.account.confirmPasswordLabel')"
				autocomplete="new-password"
			/>
			<UiButton type="submit" :loading="savingPassword">
				{{ t('dashboard.preferences.account.changePasswordSubmit') }}
			</UiButton>
		</form>
		<!--
			The password is one of two things guarding this account, and until
			now the other one had no entry point anywhere in the app. Sessions
			and two-factor live one click from the field that sets the first.
		-->
		<p class="text-sm text-text-secondary mt-4 pt-4 border-t border-border-subtle">
			<NuxtLink to="/dashboard/preferences/security" class="link">
				{{ t('dashboard.preferences.account.securityLink') }}
			</NuxtLink>
		</p>
	</div>
</template>
