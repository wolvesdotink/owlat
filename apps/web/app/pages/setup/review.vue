<script setup lang="ts">
import {
	SETUP_WIZARD_STEPS,
	interpretSetupModeProbe,
	buildApplyBody,
} from '~/composables/useSetupWizard';

definePageMeta({ layout: false });

const { t } = useI18n();

useHead({ title: () => t('setup.review.pageTitle') });

const router = useRouter();
const { flags, env, admin, isMigrationMode, summary, setupToken, goToStep, completeSetup } =
	useSetupWizard();
const { getStepStatus, isConnectorHighlighted } = useWizard(SETUP_WIZARD_STEPS, 'review');

// `SETUP_WIZARD_STEPS` carries message KEYS (it is built at module scope); the
// indicator renders display text, so resolve them here — as a computed, so the
// labels follow a locale switch instead of freezing at setup.
const displaySteps = computed(() =>
	SETUP_WIZARD_STEPS.map((step) => ({ ...step, label: t(step.label) }))
);

// The privileged apply endpoint authenticates with the one-time setup token.
const trimmedToken = computed(() => setupToken.value.trim());
const canLaunch = computed(() => !summary.value.missingProvider && trimmedToken.value !== '');

const GENERATED_SECRETS = [
	'BETTER_AUTH_SECRET',
	'INSTANCE_SECRET',
	'UNSUBSCRIBE_SECRET',
	'MTA_API_KEY',
	'MTA_WEBHOOK_SECRET',
	'REDIS_PASSWORD',
];

type Phase = 'idle' | 'applying' | 'finalizing';
const phase = ref<Phase>('idle');
const error = ref('');
const redirectTarget = ref('/auth/login?postSetup=1');
// Poll state drives the phased RestartProgress readout — number of readiness
// probes elapsed since apply, and whether the probe has cleared.
const pollCount = ref(0);
const restartReady = ref(false);

let pollTimer: ReturnType<typeof setTimeout> | null = null;

// After apply, the still-running web process keeps OWLAT_SETUP_MODE=true until it
// restarts with the freshly-written .env — so a naive redirect to /auth/login is
// bounced straight back to /setup by the setup-mode middleware. Instead we poll a
// setup-only endpoint: it answers 4xx while setup mode is live and 403 once the
// restart lands, at which point it's safe to navigate.
async function probeSetupCleared(): Promise<boolean> {
	try {
		const res = await fetch('/api/setup/validate-provider', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Setup-Token': trimmedToken.value },
			body: '{}',
		});
		return interpretSetupModeProbe(res.status);
	} catch {
		// A transient failure mid-restart counts as "not ready yet".
		return false;
	}
}

function stopPolling() {
	if (pollTimer) {
		clearTimeout(pollTimer);
		pollTimer = null;
	}
}

async function pollUntilReady() {
	if (await probeSetupCleared()) {
		stopPolling();
		restartReady.value = true;
		window.location.href = redirectTarget.value;
		return;
	}
	pollCount.value += 1;
	// Keep polling regardless — a managed restart auto-advances; the phased
	// readout (and, past ~24s, the manual-restart affordance) is derived from
	// pollCount by RestartProgress.
	pollTimer = setTimeout(pollUntilReady, 2000);
}

async function apply() {
	phase.value = 'applying';
	error.value = '';
	try {
		const res = await $fetch<{ ok: boolean; message?: string; redirectTo?: string }>(
			'/api/setup/apply',
			{
				method: 'POST',
				headers: { 'X-Setup-Token': trimmedToken.value },
				body: buildApplyBody(flags.value, env.value, admin.value, isMigrationMode.value),
			}
		);
		if (!res.ok) {
			error.value = res.message ?? t('setup.review.errorUnknown');
			phase.value = 'idle';
			return;
		}
		// Setup is done: drop the persisted draft and disarm the unload warning so
		// the redirect below isn't blocked by the "unsaved changes" prompt.
		completeSetup();
		// Server response could be tampered with; clamp to a same-origin path.
		redirectTarget.value = safeRedirect(res.redirectTo, '/auth/login?postSetup=1');
		phase.value = 'finalizing';
		pollCount.value = 0;
		restartReady.value = false;
		pollUntilReady();
	} catch (e) {
		error.value = (e as Error).message;
		phase.value = 'idle';
	}
}

function continueNow() {
	stopPolling();
	window.location.href = redirectTarget.value;
}

onUnmounted(stopPolling);
</script>

<template>
	<div class="relative isolate min-h-screen overflow-hidden bg-bg-base text-text-primary">
		<UiHeroField />

		<div class="relative mx-auto max-w-2xl px-6 py-12">
			<div class="flex items-center gap-3 mb-8">
				<UiIconBox icon="lucide:feather" size="md" variant="brand" rounded="xl" />
				<span class="lp-eyebrow">{{ t('setup.review.eyebrow') }}</span>
			</div>

			<UiStepIndicator
				class="mb-10"
				:steps="displaySteps"
				:get-step-status="getStepStatus as (stepId: string) => 'completed' | 'current' | 'upcoming'"
				:is-connector-highlighted="isConnectorHighlighted"
				:on-step-click="goToStep"
			/>

			<header class="mb-6">
				<I18nT
					keypath="setup.review.title"
					tag="h1"
					scope="global"
					class="text-3xl font-medium tracking-[-0.02em] mb-2"
				>
					<template #accent>
						<span class="lp-title-accent">{{ t('setup.review.titleAccent') }}</span>
					</template>
				</I18nT>
				<p class="text-text-secondary leading-relaxed">
					{{ t('setup.review.intro') }}
				</p>
			</header>

			<UiCard padding="lg">
				<dl class="divide-y divide-border-subtle">
					<div class="grid grid-cols-[10rem_1fr] gap-4 py-3 first:pt-0">
						<dt class="text-sm font-medium text-text-secondary">
							{{ t('setup.review.activeFeatures') }}
						</dt>
						<dd>
							<div v-if="summary.activeFeatures.length" class="flex flex-wrap gap-1.5">
								<UiBadge v-for="f in summary.activeFeatures" :key="f" variant="default">{{
									f
								}}</UiBadge>
							</div>
							<span v-else class="text-sm text-text-tertiary">{{
								t('setup.review.noneEnabled')
							}}</span>
						</dd>
					</div>

					<!-- When "moving from another platform" is chosen the server enables the
					     external-mailbox import before persisting, so reflect it here — the
					     operator confirms exactly what gets applied. -->
					<div v-if="isMigrationMode" class="grid grid-cols-[10rem_1fr] gap-4 py-3">
						<dt class="text-sm font-medium text-text-secondary">
							{{ t('setup.review.mailboxImport') }}
						</dt>
						<dd class="text-sm text-text-primary">
							{{ t('setup.review.mailboxImportEnabled') }}
						</dd>
					</div>

					<div class="grid grid-cols-[10rem_1fr] gap-4 py-3">
						<dt class="text-sm font-medium text-text-secondary">
							{{ t('setup.review.emailProvider') }}
						</dt>
						<!-- The summary is built by a pure module, so its label is a message
						     key; an already-translated label passes through `t` unchanged. -->
						<dd class="text-sm text-text-primary">{{ t(summary.providerLabel) }}</dd>
					</div>

					<div v-if="summary.fromIdentity" class="grid grid-cols-[10rem_1fr] gap-4 py-3">
						<dt class="text-sm font-medium text-text-secondary">
							{{ t('setup.review.fromIdentity') }}
						</dt>
						<dd class="text-sm text-text-primary font-mono">{{ summary.fromIdentity }}</dd>
					</div>

					<div class="grid grid-cols-[10rem_1fr] gap-4 py-3">
						<dt class="text-sm font-medium text-text-secondary">
							{{ t('setup.review.adminAccount') }}
						</dt>
						<dd class="text-sm text-text-primary">
							{{ summary.adminEmail || t('setup.review.notSet') }}
							<span v-if="summary.adminName" class="text-text-tertiary">{{
								t('setup.review.adminName', { name: summary.adminName })
							}}</span>
						</dd>
					</div>

					<div class="grid grid-cols-[10rem_1fr] gap-4 py-3 last:pb-0">
						<dt class="text-sm font-medium text-text-secondary">
							{{ t('setup.review.generatedSecrets') }}
						</dt>
						<I18nT
							keypath="setup.review.generatedSecretsNote"
							tag="dd"
							scope="global"
							class="text-sm text-text-tertiary"
						>
							<template #secrets>
								<span class="font-mono">{{ GENERATED_SECRETS.join(', ') }}</span>
							</template>
						</I18nT>
					</div>
				</dl>
			</UiCard>

			<div class="mt-5">
				<UiInput
					v-model="setupToken"
					type="password"
					:label="t('setup.review.setupTokenLabel')"
					placeholder="stk_…"
					autocomplete="off"
					autofocus
					:help-text="t('setup.review.setupTokenHelp')"
				/>
			</div>

			<div v-if="summary.missingProvider" class="mt-5">
				<UiErrorAlert
					variant="warning"
					:title="t('setup.review.missingProviderTitle')"
					:message="t('setup.review.missingProviderMessage')"
				/>
			</div>

			<div v-if="error" class="mt-5">
				<UiErrorAlert variant="error" :message="error" />
			</div>

			<div v-if="phase === 'finalizing'" class="mt-5 space-y-3">
				<UiErrorAlert
					variant="success"
					:title="t('setup.review.appliedTitle')"
					:message="t('setup.review.appliedMessage')"
				/>
				<RestartProgress :poll-count="pollCount" :ready="restartReady">
					<template #timeout>
						<I18nT keypath="setup.review.restartTimeout" tag="span" scope="global">
							<template #command>
								<code class="font-mono text-text-primary">docker compose</code>
							</template>
						</I18nT>
						<div class="mt-3">
							<UiButton variant="outline" size="sm" @click="continueNow">{{
								t('setup.review.continueToSignIn')
							}}</UiButton>
						</div>
					</template>
				</RestartProgress>
			</div>

			<footer class="mt-8 flex items-center justify-between border-t border-border-subtle pt-6">
				<UiButton variant="ghost" :disabled="phase !== 'idle'" @click="router.push('/setup/admin')">
					<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4 mr-2" /></template>
					{{ t('common.back') }}
				</UiButton>
				<UiButton
					:loading="phase === 'applying'"
					:disabled="phase !== 'idle' || !canLaunch"
					@click="apply"
				>
					{{
						phase === 'applying'
							? t('setup.review.applying')
							: phase === 'finalizing'
								? t('setup.review.finishing')
								: t('setup.review.launch')
					}}
					<template v-if="phase === 'idle'" #iconRight
						><Icon name="lucide:rocket" class="w-4 h-4 ml-2"
					/></template>
				</UiButton>
			</footer>
		</div>
	</div>
</template>
