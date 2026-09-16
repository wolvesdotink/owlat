<script setup lang="ts">
/**
 * Where Google sends the user back after the consent screen.
 *
 * A PAGE rather than an HTTP route on purpose: the exchange runs as an authed
 * Convex action, so the session that started the flow is still the one that
 * finishes it, and every existing session-bound connect/update mutation is
 * reused untouched. All this page carries is `code` + `state` — what the
 * exchange should DO was recorded when the flow started, keyed by `state`.
 */
import { api } from '@owlat/api';

const { t } = useI18n();
const KEY = 'oauth.google.callback';

definePageMeta({ layout: 'dashboard', middleware: 'auth' });
useHead({ title: () => t(`${KEY}.pageTitle`) });

const route = useRoute();

const errorMessage = ref<string | null>(null);
/** Google said no (the user declined, or the client is misconfigured). */
const denied = ref(false);

const completeOp = useBackendOperation(api.mail.external.googleOAuthActions.complete, {
	type: 'action',
	label: () => t(`${KEY}.operation`),
	inlineTarget: errorMessage,
});

// The code is single-use: a second exchange fails and would paint an error over
// a connection that actually worked. Guard the run rather than the mount.
let exchangeStarted = false;

async function exchange(): Promise<void> {
	if (exchangeStarted) return;
	exchangeStarted = true;

	const query = route.query;
	const code = typeof query['code'] === 'string' ? query['code'] : null;
	const state = typeof query['state'] === 'string' ? query['state'] : null;
	if (typeof query['error'] === 'string' && query['error']) {
		denied.value = true;
		return;
	}
	if (!code || !state) {
		errorMessage.value = t(`${KEY}.missingParams`);
		return;
	}

	const res = await completeOp.run({ code, state });
	if (!res.ok) {
		// `inlineTarget` only catches the invalid-input family; anything else was
		// toasted, and this page would otherwise sit blank behind the toast.
		if (!errorMessage.value) errorMessage.value = t(`${KEY}.failed`);
		return;
	}
	await navigateTo(res.result.returnTo, { replace: true });
}

onMounted(() => {
	void exchange();
});

const isWorking = computed(() => !denied.value && !errorMessage.value);
</script>

<template>
	<div class="p-6 lg:p-8 max-w-lg mx-auto">
		<UiCard padding="lg">
			<div v-if="isWorking" class="flex items-center gap-3" aria-live="polite">
				<Icon
					name="lucide:loader-2"
					class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary"
				/>
				<p class="text-sm text-text-secondary">{{ t(`${KEY}.connecting`) }}</p>
			</div>

			<div v-else class="flex items-start gap-3">
				<UiIconBox icon="lucide:alert-triangle" size="md" variant="error" rounded="xl" />
				<div>
					<h1 class="font-semibold">
						{{ denied ? t(`${KEY}.deniedTitle`) : t(`${KEY}.failedTitle`) }}
					</h1>
					<p class="text-sm text-text-secondary mt-0.5">
						{{ denied ? t(`${KEY}.denied`) : errorMessage }}
					</p>
					<UiButton class="mt-4" variant="secondary" to="/dashboard/postbox/migrate">
						{{ t(`${KEY}.back`) }}
					</UiButton>
				</div>
			</div>
		</UiCard>
	</div>
</template>
