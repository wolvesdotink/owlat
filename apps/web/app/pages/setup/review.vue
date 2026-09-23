<script setup lang="ts">
import {
	SETUP_WIZARD_STEPS,
	interpretSetupModeProbe,
	buildApplyBody,
	setupSignInHref,
} from '~/composables/useSetupWizard';
import { FEATURE_FLAGS, type FeatureFlagKey } from '@owlat/shared/featureFlags';
import {
	SETUP_TOKEN_FIELD_ID,
	groupActiveFeatures,
	launchBlockers,
} from '~/composables/setupWizardReview';
import { useFeatureCopy } from '~/composables/useFeatureCopy';
import { isCsrfRejection } from '~/lib/csrf';
import { apiFetch } from '~/lib/csrfFetch';

definePageMeta({ layout: false });

const { t } = useI18n();
const { flagKeyLabel, packLabel } = useFeatureCopy();

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

// Every reason Launch is disabled, listed next to the button and linked to the
// step (or field) that fixes it — a disabled button alone explains nothing.
const blockers = computed(() =>
	launchBlockers({
		missingProvider: summary.value.missingProvider,
		admin: admin.value,
		setupToken: setupToken.value,
	})
);
const canLaunch = computed(() => blockers.value.length === 0);

// Active features by their names, under the pack they belong to.
const featureGroups = computed(() => groupActiveFeatures(summary.value.activeFeatures));
function groupLabel(pack: ReturnType<typeof groupActiveFeatures>[number]['pack']): string {
	return pack === 'other' ? t('setup.review.otherFeatures') : packLabel(pack);
}
function featureLabel(flag: FeatureFlagKey): string {
	return flagKeyLabel(flag, FEATURE_FLAGS[flag as keyof typeof FEATURE_FLAGS]);
}

// A blocker that lives on this page (the setup token) focuses its field rather
// than navigating; the rest go back to their wizard step.
function goToBlocker(to: string) {
	if (to.startsWith('#')) {
		document.getElementById(to.slice(1))?.focus();
		return;
	}
	router.push(to);
}

const GENERATED_SECRETS = [
	'BETTER_AUTH_SECRET',
	'INSTANCE_SECRET',
	'UNSUBSCRIBE_SECRET',
	'MTA_API_KEY',
	'MTA_WEBHOOK_SECRET',
	'REDIS_PASSWORD',
];

type Phase = 'idle' | 'applying' | 'finalizing' | 'complete';
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
		// `apiFetch.raw` (not a bare `fetch`) so the request carries the CSRF
		// token; `ignoreResponseError` keeps the status readable instead of
		// thrown.
		const res = await apiFetch.raw('/api/setup/validate-provider', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Setup-Token': trimmedToken.value },
			body: '{}',
			retry: 0,
			ignoreResponseError: true,
		});
		// The CSRF middleware in front of this endpoint answers 403 too, and
		// reading THAT as the all-clear would hand the operator to a login form
		// the still-unrestarted process bounces straight back to /setup.
		if (isCsrfRejection(res._data)) return false;
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

/**
 * The finale's exits — every one an ANCHOR, which is what makes the handoff the
 * wizard's single full page load (see `setupSignInHref` for why a load and not a
 * `router.push`). Each row is a real destination behind the sign-in, so the
 * operator leaves pointed at something rather than at a bare login form.
 */
function signInHref(next?: string): string {
	return setupSignInHref(redirectTarget.value, next);
}

const NEXT_STEPS = [
	{ id: 'domain', icon: 'lucide:globe', to: '/dashboard/admin/delivery/domains' },
	{ id: 'team', icon: 'lucide:user-plus', to: '/dashboard/admin/team' },
	{ id: 'postbox', icon: 'lucide:inbox', to: '/dashboard/postbox' },
] as const;

async function pollUntilReady() {
	if (await probeSetupCleared()) {
		stopPolling();
		restartReady.value = true;
		// The restart landed: show the finale rather than dumping the operator on a
		// bare login form. Leaving is a deliberate click from there.
		phase.value = 'complete';
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
		const res = await apiFetch<{ ok: boolean; message?: string; redirectTo?: string }>(
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

// Manual-restart escape hatch: the operator restarts the container themselves, so
// the probe never clears. Skip straight to the finale — the handoff is still the
// one page load, taken from there.
function continueNow() {
	stopPolling();
	phase.value = 'complete';
}

onUnmounted(stopPolling);
</script>

<template>
	<div class="relative isolate min-h-screen overflow-hidden bg-bg-base text-text-primary">
		<UiHeroField />

		<!-- ─────────────────────── The finale ─────────────────────── -->
		<!-- Setup ends on an acknowledgement, not on a login form: eyebrow, title,
		     one lead, and three real next steps. Every exit from here is an anchor,
		     so leaving IS the single page load the restarted process needs (see
		     `signInHref`) — there is no second reload anywhere in this flow. -->
		<div v-if="phase === 'complete'" class="relative mx-auto max-w-2xl px-6 py-12">
			<div class="flex items-center gap-3 mb-8">
				<UiIconBox icon="lucide:party-popper" size="md" variant="brand" rounded="xl" />
				<span class="lp-eyebrow">{{ t('setup.review.complete.eyebrow') }}</span>
			</div>

			<header class="mb-6">
				<I18nT
					keypath="setup.review.complete.title"
					tag="h1"
					scope="global"
					class="text-3xl font-medium tracking-[-0.02em] mb-2"
				>
					<template #accent>
						<span class="lp-title-accent">{{ t('setup.review.complete.titleAccent') }}</span>
					</template>
				</I18nT>
				<p class="max-w-[34rem] text-text-secondary leading-relaxed">
					{{ t('setup.review.complete.intro') }}
				</p>
			</header>

			<h2 class="lp-eyebrow mb-3">{{ t('setup.review.complete.nextHeading') }}</h2>
			<ul class="space-y-2">
				<li v-for="step in NEXT_STEPS" :key="step.id">
					<a
						:href="signInHref(step.to)"
						class="flex items-center gap-4 rounded-xl bg-surface-1 shadow-surface-1 border border-transparent px-4 py-3 transition-[box-shadow] duration-(--motion-fast) ease-spring hover:shadow-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
					>
						<Icon :name="step.icon" class="h-5 w-5 shrink-0 text-text-tertiary" />
						<span class="min-w-0 flex-1">
							<span class="block font-medium text-text-primary">{{
								t(`setup.review.complete.next.${step.id}.title`)
							}}</span>
							<span class="block text-sm text-text-secondary">{{
								t(`setup.review.complete.next.${step.id}.desc`)
							}}</span>
						</span>
						<span class="shrink-0 text-caption text-text-tertiary">{{
							t(`setup.review.complete.next.${step.id}.meta`)
						}}</span>
					</a>
				</li>
			</ul>

			<div class="mt-8">
				<UiButton size="lg" :href="signInHref()">
					{{ t('setup.review.complete.signIn') }}
					<template #iconRight><Icon name="lucide:arrow-right" class="w-4 h-4 ml-2" /></template>
				</UiButton>
			</div>
		</div>

		<div v-else class="relative mx-auto max-w-2xl px-6 py-12">
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
							<div v-if="featureGroups.length" class="space-y-3" data-testid="review-features">
								<div v-for="group in featureGroups" :key="group.pack">
									<p class="text-xs font-medium text-text-tertiary">{{ groupLabel(group.pack) }}</p>
									<p class="text-sm text-text-primary">
										{{ group.flags.map(featureLabel).join(', ') }}
									</p>
								</div>
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
						<dd class="text-sm text-text-secondary">
							<I18nT keypath="setup.review.generatedSecretsNote" tag="p" scope="global">
								<template #file><code class="font-mono">.env</code></template>
							</I18nT>
							<details class="mt-1" data-testid="review-secrets">
								<summary class="cursor-pointer text-text-tertiary hover:text-text-secondary">
									{{ t('setup.review.generatedSecretsShow') }}
								</summary>
								<ul class="mt-1 font-mono text-xs text-text-tertiary">
									<li v-for="name in GENERATED_SECRETS" :key="name">{{ name }}</li>
								</ul>
							</details>
						</dd>
					</div>
				</dl>
			</UiCard>

			<div class="mt-5">
				<UiInput
					:id="SETUP_TOKEN_FIELD_ID"
					v-model="setupToken"
					type="password"
					:label="t('setup.review.setupTokenLabel')"
					placeholder="stk_…"
					autocomplete="off"
					autofocus
					:help-text="t('setup.review.setupTokenHelp')"
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

			<footer
				class="mt-8 flex flex-wrap items-start justify-between gap-4 border-t border-border-subtle pt-6"
			>
				<UiButton variant="ghost" :disabled="phase !== 'idle'" @click="router.push('/setup/admin')">
					<template #iconLeft><Icon name="lucide:arrow-left" class="w-4 h-4 mr-2" /></template>
					{{ t('common.back') }}
				</UiButton>
				<div class="flex flex-col items-end gap-3">
					<ul
						v-if="phase === 'idle' && blockers.length"
						id="launch-blockers"
						class="space-y-1 text-right text-sm text-text-secondary"
						data-testid="launch-blockers"
					>
						<li v-for="blocker in blockers" :key="blocker.id">
							<a
								:href="blocker.to"
								class="link"
								:data-testid="`launch-blocker-${blocker.id}`"
								@click.prevent="goToBlocker(blocker.to)"
								>{{ t(blocker.message) }}</a
							>
						</li>
					</ul>
					<UiButton
						:loading="phase === 'applying'"
						:disabled="phase !== 'idle' || !canLaunch"
						:aria-describedby="phase === 'idle' && blockers.length ? 'launch-blockers' : undefined"
						data-testid="launch-button"
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
				</div>
			</footer>
		</div>
	</div>
</template>
