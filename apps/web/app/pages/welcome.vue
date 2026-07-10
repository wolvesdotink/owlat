<script setup lang="ts">
import { api } from '@owlat/api';

/**
 * First-login welcome screen (piece c1).
 *
 * A brand-new member is routed here once by the `first-login` middleware. The
 * screen adapts to the instance mode:
 *
 * - FRESH START (default, `isMigrationMode` off): a pure product welcome that
 *   flows straight into the Postbox. No import surface is ever shown.
 * - MIGRATION MODE (`isMigrationMode` on): two equal choices — bring existing
 *   email over, or start fresh — plus a quiet "I'll do this later" skip.
 *
 * Landing here records `welcomedAt`, so the member is "returning" from now on and
 * is never bounced back. Every path is skippable and resumable from the
 * persistent onboarding checklist (OnboardingUserChecklist), so leaving mid-flow
 * costs nothing.
 */

useHead({ title: 'Welcome — Owlat' });

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
// links can fire. Both exits ("I'll do this later" → /dashboard, "Go to my inbox"
// → /dashboard/postbox) land on trigger paths, so without this a fast click could
// beat the fire-and-forget mutation below and bounce the member back to /welcome.
const firstLoginResolved = useState('first-login-resolved', () => false);
firstLoginResolved.value = true;

// Record that this member has now seen the welcome — best-effort and idempotent,
// so a failure here simply means the middleware may route them once more in a
// LATER session; it must never surface an error on the welcome screen itself.
onMounted(async () => {
	const userId = user.value?.id;
	if (!userId || !$convex) return;
	try {
		await $convex.mutation(api.auth.userOnboarding.markWelcomed, { userId });
	} catch {
		// Non-fatal — see above.
	}
});
</script>

<template>
	<div class="min-h-screen bg-bg-deep flex items-center justify-center p-6">
		<div class="w-full max-w-2xl">
			<!-- Loading the instance mode -->
			<div v-if="isLoadingSettings" class="card flex items-center justify-center gap-3 py-16">
				<UiSpinner size="sm" />
				<span class="text-sm text-text-secondary">Getting things ready…</span>
			</div>

			<div v-else class="card">
				<!-- Shared header -->
				<div class="text-center">
					<UiIconBox icon="lucide:party-popper" variant="brand" size="lg" class="mx-auto mb-6" />
					<h1 class="text-2xl font-semibold text-text-primary">
						Welcome to {{ instanceName }}<template v-if="firstName">, {{ firstName }}</template>
					</h1>
					<p class="mt-2 text-text-secondary">
						This is your team's home for email. Let's get you in.
					</p>
				</div>

				<!-- MIGRATION MODE: two equal choices -->
				<template v-if="isMigrationMode">
					<div class="mt-8 grid gap-4 sm:grid-cols-2">
						<NuxtLink
							to="/dashboard/postbox/migrate"
							class="group flex flex-col rounded-xl border border-border-subtle bg-bg-surface/50 p-5 text-left transition-all hover:border-brand hover:bg-bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
						>
							<UiIconBox icon="lucide:import" variant="surface" size="sm" />
							<h2 class="mt-4 font-medium text-text-primary">Bring my email with me</h2>
							<p class="mt-1 text-sm text-text-secondary">
								Import your existing inbox so nothing is left behind.
							</p>
							<span
								class="mt-4 inline-flex items-center gap-1 text-sm text-brand opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
							>
								Start import
								<Icon name="lucide:chevron-right" class="h-4 w-4" />
							</span>
						</NuxtLink>

						<NuxtLink
							to="/dashboard/postbox"
							class="group flex flex-col rounded-xl border border-border-subtle bg-bg-surface/50 p-5 text-left transition-all hover:border-brand hover:bg-bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
						>
							<UiIconBox icon="lucide:sparkles" variant="surface" size="sm" />
							<h2 class="mt-4 font-medium text-text-primary">Start fresh</h2>
							<p class="mt-1 text-sm text-text-secondary">
								Skip the import and begin with a clean inbox.
							</p>
							<span
								class="mt-4 inline-flex items-center gap-1 text-sm text-brand opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
							>
								Go to my inbox
								<Icon name="lucide:chevron-right" class="h-4 w-4" />
							</span>
						</NuxtLink>
					</div>

					<div class="mt-6 text-center">
						<NuxtLink
							to="/dashboard"
							class="text-sm text-text-tertiary transition-colors hover:text-text-secondary"
						>
							I'll do this later
						</NuxtLink>
					</div>
				</template>

				<!-- FRESH START (default): a two-minute setup that lands in Postbox. -->
				<template v-else>
					<OnboardingFreshStart />
				</template>
			</div>
		</div>
	</div>
</template>
