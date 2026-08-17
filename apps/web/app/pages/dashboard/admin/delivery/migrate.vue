<script setup lang="ts">
/**
 * "Migrate from Mailchimp/Mandrill" — the runbook (plan §10) as a screen.
 *
 * The five steps are the runbook's five steps, in its order: connect the key,
 * carry the history across, verify the sending domain at Mandrill, apply the
 * measured-split preset, then watch the ramp. Nothing here is new machinery —
 * every step drives a shipped mutation — and the only thing this page adds is
 * the ORDER and the gating, which is exactly what makes the migration safe:
 * applying the preset before Mandrill has verified the domain names a relay
 * that cannot send, and importing contacts before the suppressions exist mails
 * people who left.
 *
 * COMPLETION IS READ, NOT REMEMBERED. Every step's done-ness is derived from the
 * same queries the rest of Delivery reads — the transport catalog, the routes,
 * the Mandrill identities — so a reload, or a route changed on the
 * provider-routing screen, is reflected rather than contradicted. The one
 * exception is the carry-over: an import that ran last week leaves no flag this
 * page can honestly read, so that step reports on the run it just watched and
 * stays re-runnable (which is free — both imports are idempotent).
 *
 * Steps that own real work are self-contained components, following the
 * `<DeliveryRelayDomainStatus />` precedent: this page is at the file-size
 * cap's doorstep like every other Delivery page, and a flow assembled from
 * drop-in steps is one where each step can be tested without the flow.
 */
import { api } from '@owlat/api';
import {
	isMigrationDomainReady,
	isMigrationPresetApplied,
	isTransportConfigured,
	migrationDomainRows,
	migrationSteps,
	MIGRATION_RELAY_KIND,
	type MigrationStepState,
} from '~/utils/mandrillMigration';

const { t } = useI18n();

/**
 * `utils/mandrillMigration` is a module-scope definition set whose step
 * title/summary/blocked copy carries i18n keys rather than sentences (the
 * registry convention); a plain string is still accepted so a value with nothing
 * to translate reads as itself.
 */
type LocalizedText = string | { key: string; params?: Record<string, unknown> };
function localized(value: LocalizedText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

useHead({ title: () => t('dashboard.admin.delivery.migrate.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: ['auth', 'admin'],
});

// Every write this page offers — the history import, the routing preset, the ramp
// pace — is an adminMutation, and the `admin` route middleware above is what keeps
// a non-admin away from them: it waits for the role and redirects to /dashboard
// before this page renders. So the steps below are written for an admin reader,
// with no in-page permission read and no "owners and admins only" card that
// nobody could reach.
const { data: catalog } = useOrganizationQuery(api.providerRoutes.listTransportCatalog);
const { data: routes } = useOrganizationQuery(api.providerRoutes.listRoutes);
const { data: identities } = useOrganizationQuery(api.domains.mandrillRelayQueries.listIdentities);

/** Set by the carry-over step when its two runs both finish. */
const isHistoryCarried = ref(false);
/** Optimistic within the session; the routes query is the authority on reload. */
const wasPresetApplied = ref(false);

const isKeyConnected = computed(() => isTransportConfigured(catalog.value, MIGRATION_RELAY_KIND));
// The clock is read inside the computed so a page left open across a proof
// expiry catches up on the next refresh instead of holding a stale "verified".
const isDomainReady = computed(() => isMigrationDomainReady(identities.value, Date.now()));
const domainRows = computed(() => migrationDomainRows(identities.value, Date.now()));
const isPresetApplied = computed(
	() => wasPresetApplied.value || isMigrationPresetApplied(routes.value)
);

const steps = computed(() =>
	migrationSteps({
		isKeyConnected: isKeyConnected.value,
		isHistoryCarried: isHistoryCarried.value,
		isDomainReady: isDomainReady.value,
		isPresetApplied: isPresetApplied.value,
	})
);

function stepByIdState(id: string): MigrationStepState {
	return steps.value.find((step) => step.id === id)?.state ?? 'upcoming';
}

function blockedReason(id: string): string | null {
	const blockedBy = steps.value.find((step) => step.id === id)?.blockedBy;
	return blockedBy === undefined || blockedBy === null ? null : localized(blockedBy);
}

const STATE_ICON: Readonly<Record<MigrationStepState, string>> = {
	complete: 'lucide:check-circle-2',
	current: 'lucide:circle-dot',
	blocked: 'lucide:lock',
	upcoming: 'lucide:circle',
};

const STATE_CLASS: Readonly<Record<MigrationStepState, string>> = {
	complete: 'text-success',
	current: 'text-brand',
	blocked: 'text-text-tertiary',
	upcoming: 'text-text-tertiary',
};
</script>

<template>
	<div class="p-6 lg:p-8">
		<div class="mb-6">
			<NuxtLink
				to="/dashboard/admin/delivery"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				{{ t('dashboard.admin.delivery.backToSetup') }}
			</NuxtLink>
			<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
				{{ t('dashboard.admin.delivery.migrate.title') }}
			</h1>
			<p class="mt-2 max-w-3xl text-sm text-text-secondary">
				{{ t('dashboard.admin.delivery.migrate.lede') }}
			</p>
		</div>

		<ol class="space-y-4" data-testid="migration-steps">
			<li
				v-for="step in steps"
				:key="step.id"
				class="card p-6"
				:data-testid="`migration-step-${step.id}`"
				:data-state="step.state"
			>
				<div class="flex items-start gap-3">
					<Icon
						:name="STATE_ICON[step.state]"
						class="mt-0.5 h-5 w-5 shrink-0"
						:class="STATE_CLASS[step.state]"
					/>
					<div class="min-w-0 flex-1 space-y-3">
						<div>
							<h2 class="text-base font-semibold text-text-primary">
								{{ localized(step.title) }}
							</h2>
							<p class="mt-1 text-sm text-text-secondary">{{ localized(step.summary) }}</p>
						</div>

						<!-- 1 · Connect ------------------------------------------------ -->
						<template v-if="step.id === 'connect'">
							<p
								v-if="isKeyConnected"
								class="text-sm text-success"
								data-testid="migration-key-present"
							>
								<I18nT keypath="dashboard.admin.delivery.migrate.connect.present" scope="global">
									<template #envVar><code>MANDRILL_API_KEY</code></template>
								</I18nT>
							</p>
							<div v-else class="space-y-2" data-testid="migration-key-missing">
								<I18nT
									keypath="dashboard.admin.delivery.migrate.connect.missing"
									tag="p"
									class="text-sm text-text-secondary"
									scope="global"
								>
									<template #envVar><code>MANDRILL_API_KEY</code></template>
								</I18nT>
								<NuxtLink
									to="/dashboard/admin/delivery/transport"
									class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-brand"
								>
									<Icon name="lucide:external-link" class="h-4 w-4" />
									{{ t('dashboard.admin.delivery.migrate.connect.transportLink') }}
								</NuxtLink>
							</div>
						</template>

						<!-- 2 · Carry over history ------------------------------------- -->
						<DeliveryMigrationImportStep
							v-else-if="step.id === 'history'"
							:is-blocked="stepByIdState('history') === 'blocked'"
							:blocked-reason="blockedReason('history')"
							@carried="(value: boolean) => (isHistoryCarried = value)"
						/>

						<!-- 3 · Verify the domain -------------------------------------- -->
						<template v-else-if="step.id === 'domain'">
							<p
								v-if="domainRows.length === 0"
								class="text-sm text-text-secondary"
								data-testid="migration-domain-none"
							>
								{{ t('dashboard.admin.delivery.migrate.domain.none') }}
							</p>
							<ul v-else class="space-y-1 text-sm" data-testid="migration-domain-checklist">
								<li
									v-for="row in domainRows"
									:key="row.domain"
									:data-testid="`migration-domain-${row.domain}`"
								>
									<span :class="row.isReady ? 'text-success' : 'text-warning'">
										{{
											row.isReady
												? t('dashboard.admin.delivery.migrate.domain.ready', {
														domain: row.domain,
													})
												: t('dashboard.admin.delivery.migrate.domain.outstanding', {
														domain: row.domain,
														outstanding: row.outstanding.map(localized).join(', '),
													})
										}}
									</span>
								</li>
							</ul>
							<DeliveryRelayDomainStatus />
							<NuxtLink
								to="/dashboard/admin/delivery/domains"
								class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-brand"
							>
								<Icon name="lucide:globe" class="h-4 w-4" />
								{{ t('dashboard.admin.delivery.migrate.domain.domainsLink') }}
							</NuxtLink>
						</template>

						<!-- 4 · The preset --------------------------------------------- -->
						<DeliveryMigrationPresetStep
							v-else-if="step.id === 'preset'"
							:catalog="catalog ?? null"
							:routes="routes ?? null"
							:is-applied="isPresetApplied"
							:is-blocked="stepByIdState('preset') === 'blocked'"
							:blocked-reason="blockedReason('preset')"
							@applied="wasPresetApplied = true"
						/>

						<!-- 5 · Watch -------------------------------------------------- -->
						<template v-else-if="step.id === 'watch'">
							<p v-if="step.blockedBy" class="text-sm text-text-secondary">
								{{ localized(step.blockedBy) }}
							</p>
							<div v-else class="flex flex-wrap gap-4">
								<NuxtLink
									to="/dashboard/admin/delivery/advanced/cells"
									class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-brand"
									data-testid="migration-cells-link"
								>
									<Icon name="lucide:grid-3x3" class="h-4 w-4" />
									{{ t('dashboard.admin.delivery.migrate.watch.cells') }}
								</NuxtLink>
								<NuxtLink
									to="/dashboard/admin/delivery/advanced/controls"
									class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-brand"
								>
									<Icon name="lucide:sliders-horizontal" class="h-4 w-4" />
									{{ t('dashboard.admin.delivery.migrate.watch.controls') }}
								</NuxtLink>
								<NuxtLink
									to="/dashboard/admin/delivery/advanced/independence"
									class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-brand"
								>
									<Icon name="lucide:trending-up" class="h-4 w-4" />
									{{ t('dashboard.admin.delivery.migrate.watch.independence') }}
								</NuxtLink>
							</div>
						</template>
					</div>
				</div>
			</li>
		</ol>
	</div>
</template>
