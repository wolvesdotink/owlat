<script setup lang="ts">
import { api } from '@owlat/api';
import { stampWelcomed } from '~/lib/welcomeStamp';

/**
 * First-login welcome screen.
 *
 * A brand-new member is routed here once by the `first-login` middleware. The
 * screen adapts to the instance mode:
 *
 * - FRESH START (default, `isMigrationMode` off): a pure product welcome that
 *   lands on Today. No import surface is ever shown.
 * - MIGRATION MODE (`isMigrationMode` on): two equal choices — bring existing
 *   email over, or start fresh — plus a quiet "I'll do this later" skip.
 *
 * Landing here records `welcomedAt`, so the member is "returning" from now on and
 * is never bounced back. Every path is skippable and resumable from the
 * persistent "Getting started" checklist (DashboardGettingStarted), so leaving
 * mid-flow costs nothing.
 */

const { t } = useI18n();

useHead({ title: () => t('welcome.pageTitle') });

definePageMeta({
	middleware: 'auth',
});

const { user } = useAuth();
const { organization } = useOrganizationContext();
const { $convex } = useNuxtApp();

const { data: settings, isLoading: isLoadingSettings } = useConvexQuery(
	api.workspaces.settings.get,
	{}
);

const isMigrationMode = computed<boolean>(() => settings.value?.isMigrationMode ?? false);

const instanceName = computed<string>(() => organization.value?.name?.trim() || 'Owlat');
const firstName = computed<string>(() => {
	const name = user.value?.name?.trim();
	if (!name) return '';
	return name.split(/\s+/)[0] ?? '';
});

// Reaching this screen makes the member "returning" for the rest of the session:
// flip the session-scoped flag the first-login middleware reads BEFORE the exit
// links can fire. Every exit ("I'll do this later", "Go to Today") lands on
// /dashboard, a trigger path, so without this a fast click could
// beat the fire-and-forget mutation below and bounce the member back to /welcome.
const firstLoginResolved = useState('first-login-resolved', () => false);
firstLoginResolved.value = true;

// Record that this member has now seen the welcome. Idempotent, and retried a
// few times with backoff (see ~/lib/welcomeStamp), because straight after
// sign-in the client may still be re-authenticating. Only a committed stamp is
// cached on this device: the cache lets the next session skip the first-login
// query, so it must never claim a stamp the server does not have.
//
// If every attempt fails, nothing is blocked: the member can carry on, and the
// only cost is seeing this screen again next session. A quiet note says so and
// offers to try again.
//
// The run belongs to this page and to the member it started for. Leaving the
// page, or a different member signing in, aborts it so nothing more is sent;
// the member now on the screen gets a run of their own.
const stamping = ref(false);
const stampGaveUp = ref(false);
let stampRun: AbortController | null = null;

function abortStamp(): void {
	stampRun?.abort();
	stampRun = null;
	stamping.value = false;
}

async function stamp(): Promise<void> {
	const userId = user.value?.id;
	if (!userId || !$convex) return;
	abortStamp();
	const run = new AbortController();
	stampRun = run;
	stamping.value = true;
	const result = await stampWelcomed({
		userId,
		send: () => $convex.mutation(api.auth.userOnboarding.markWelcomed, { userId }),
		signal: run.signal,
	});
	if (result === 'aborted' || stampRun !== run) return;
	stampRun = null;
	stamping.value = false;
	stampGaveUp.value = result === 'failed';
}

onMounted(() => {
	void stamp();
});

watch(
	() => user.value?.id,
	(userId, previous) => {
		if (userId === previous) return;
		abortStamp();
		stampGaveUp.value = false;
		if (userId) void stamp();
	}
);

onBeforeUnmount(abortStamp);
</script>

<template>
	<div class="min-h-screen bg-bg-deep flex items-center justify-center p-6">
		<div class="w-full max-w-2xl">
			<!-- Loading the instance mode -->
			<div v-if="isLoadingSettings" class="card flex items-center justify-center gap-3 py-16">
				<UiSpinner size="sm" />
				<span class="text-sm text-text-secondary">{{ t('welcome.loading') }}</span>
			</div>

			<div v-else class="card">
				<!-- Shared header -->
				<div class="text-center">
					<UiIconBox icon="lucide:party-popper" variant="brand" size="lg" class="mx-auto mb-6" />
					<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
						<I18nT
							:keypath="firstName ? 'welcome.headingWithName' : 'welcome.heading'"
							scope="global"
							tag="span"
						>
							<template #instance
								><span class="lp-title-accent">{{ instanceName }}</span></template
							>
							<template #name>{{ firstName }}</template>
						</I18nT>
					</h1>
					<p class="mt-2 text-text-secondary">{{ t('welcome.subheading') }}</p>
				</div>

				<!-- MIGRATION MODE: two equal choices -->
				<template v-if="isMigrationMode">
					<div class="mt-8 grid gap-4 sm:grid-cols-2">
						<NuxtLink
							to="/dashboard/postbox/migrate"
							class="group flex flex-col rounded-xl border border-border-subtle bg-bg-surface/50 p-5 text-left transition-all hover:border-brand hover:bg-bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
						>
							<UiIconBox icon="lucide:import" variant="surface" size="sm" />
							<h2 class="mt-4 font-medium text-text-primary">{{ t('welcome.migrate.title') }}</h2>
							<p class="mt-1 text-sm text-text-secondary">{{ t('welcome.migrate.body') }}</p>
							<span
								class="mt-4 inline-flex items-center gap-1 text-sm text-brand opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
							>
								{{ t('welcome.migrate.cta') }}
								<Icon name="lucide:chevron-right" class="h-4 w-4" />
							</span>
						</NuxtLink>

						<NuxtLink
							to="/dashboard"
							class="group flex flex-col rounded-xl border border-border-subtle bg-bg-surface/50 p-5 text-left transition-all hover:border-brand hover:bg-bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
						>
							<UiIconBox icon="lucide:sparkles" variant="surface" size="sm" />
							<h2 class="mt-4 font-medium text-text-primary">{{ t('welcome.fresh.title') }}</h2>
							<p class="mt-1 text-sm text-text-secondary">{{ t('welcome.fresh.body') }}</p>
							<span
								class="mt-4 inline-flex items-center gap-1 text-sm text-brand opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
							>
								{{ t('welcome.fresh.cta') }}
								<Icon name="lucide:chevron-right" class="h-4 w-4" />
							</span>
						</NuxtLink>
					</div>

					<div class="mt-6 text-center">
						<NuxtLink
							to="/dashboard"
							class="text-sm text-text-tertiary transition-colors hover:text-text-secondary"
						>
							{{ t('welcome.later') }}
						</NuxtLink>
					</div>
				</template>

				<!-- FRESH START (default): a two-minute setup that lands on Today. -->
				<template v-else>
					<OnboardingFreshStart />
				</template>
			</div>

			<p
				v-if="stampGaveUp"
				role="status"
				class="mt-4 text-center text-xs text-text-tertiary"
				data-testid="welcome-stamp-failed"
			>
				{{ t('welcome.stamp.failed') }}
				<button
					type="button"
					class="ml-1 text-text-secondary underline underline-offset-2 transition-colors hover:text-text-primary disabled:no-underline disabled:opacity-60"
					:disabled="stamping"
					@click="stamp"
				>
					{{ stamping ? t('welcome.stamp.retrying') : t('welcome.stamp.retry') }}
				</button>
			</p>
		</div>
	</div>
</template>
