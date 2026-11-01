<script setup lang="ts">
import { isValidEmail } from '@owlat/shared';
import { authClient } from '~/lib/auth-client';

const { t } = useI18n();
const { user } = useAuth();
const { showToast } = useToast();

// ── Change login email ──
// BetterAuth's change-email flow (apps/api/convex/auth/auth.ts → user.changeEmail)
// never mutates the login email directly — it always requires a confirmation
// link to be followed first, so the page just requests the change and tells the
// user where the link was sent. The destination depends on whether the account's
// email is verified:
//  - verified accounts get a link at their CURRENT address (approve → a second
//    link is sent to the new address, and following that commits the change);
//  - unverified accounts get the link straight at the NEW address.
const newEmail = ref('');
const savingEmail = ref(false);
const emailRequested = ref(false);
// The address the first confirmation link is sent to (see above). null until a
// change has been requested.
const confirmationSentTo = ref<string | null>(null);
const isEmailVerified = computed(() => user.value?.emailVerified === true);
async function changeEmail() {
	const email = newEmail.value.trim().toLowerCase();
	if (!isValidEmail(email)) {
		showToast(t('dashboard.preferences.account.emailInvalid'), 'error');
		return;
	}
	if (email === (user.value?.email ?? '').toLowerCase()) {
		showToast(t('dashboard.preferences.account.emailUnchanged'), 'error');
		return;
	}
	savingEmail.value = true;
	emailRequested.value = false;
	// Verified accounts get the first confirmation at their current address;
	// unverified accounts get it at the new one (see comment above + auth.ts).
	const destination = isEmailVerified.value ? (user.value?.email ?? email) : email;
	try {
		const res = await authClient.changeEmail({
			newEmail: email,
			callbackURL: '/dashboard/preferences/account',
		});
		if (res.error) {
			showToast(res.error.message ?? t('dashboard.preferences.account.emailChangeFailed'), 'error');
			return;
		}
		emailRequested.value = true;
		confirmationSentTo.value = destination;
		newEmail.value = '';
		showToast(t('dashboard.preferences.account.emailChangeRequested'));
	} catch {
		showToast(t('dashboard.preferences.account.emailChangeFailed'), 'error');
	} finally {
		savingEmail.value = false;
	}
}
</script>

<template>
	<div class="card">
		<h2 class="text-lg font-semibold text-text-primary mb-1">
			{{ t('dashboard.preferences.account.loginEmailTitle') }}
		</h2>
		<p v-if="isEmailVerified" class="text-sm text-text-secondary mb-4">
			{{ t('dashboard.preferences.account.loginEmailVerifiedDescription') }}
		</p>
		<p v-else class="text-sm text-text-secondary mb-4">
			{{ t('dashboard.preferences.account.loginEmailUnverifiedDescription') }}
		</p>
		<form class="space-y-3 max-w-md" @submit.prevent="changeEmail">
			<UiInput
				id="new-email"
				v-model="newEmail"
				type="email"
				:label="t('dashboard.preferences.account.newEmailLabel')"
				:placeholder="t('auth.fields.emailPlaceholder')"
				autocomplete="email"
			/>
			<UiButton type="submit" :loading="savingEmail" :disabled="!newEmail.trim()">
				{{ t('dashboard.preferences.account.sendConfirmation') }}
			</UiButton>
		</form>
		<I18nT
			v-if="emailRequested"
			:keypath="
				isEmailVerified
					? 'dashboard.preferences.account.confirmationSentApprove'
					: 'dashboard.preferences.account.confirmationSentFinish'
			"
			tag="p"
			scope="global"
			class="text-xs text-success mt-3"
		>
			<template #email>
				<span class="font-medium">{{ confirmationSentTo }}</span>
			</template>
		</I18nT>
	</div>
</template>
