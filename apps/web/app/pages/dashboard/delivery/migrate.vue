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
 * `<DeliveryMandrillDomainStatus />` precedent: this page is at the file-size
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

useHead({ title: 'Migrate from Mailchimp — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const { canManageOrganization, showAdminGate } = usePermissions();

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
	return steps.value.find((step) => step.id === id)?.blockedBy ?? null;
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
				to="/dashboard/delivery/setup"
				class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Delivery setup
			</NuxtLink>
			<h1 class="text-2xl font-semibold text-text-primary">Migrate from Mailchimp / Mandrill</h1>
			<p class="mt-2 max-w-3xl text-sm text-text-secondary">
				Keep sending through your existing Mailchimp Transactional account on day one — same
				reputation, same deliverability — while Owlat measures both senders on identical
				instrumentation and moves traffic onto its own MTA only as the numbers earn it. There is no
				flag day, and every step here is reversible.
			</p>
		</div>

		<UiCard v-if="showAdminGate" class="mb-6">
			<p class="text-sm text-text-secondary" data-testid="migrate-admin-only">
				Running the migration — importing history, applying the routing preset, choosing a ramp pace
				— is limited to workspace owners and admins. The steps below still show you where the
				migration currently stands.
			</p>
		</UiCard>

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
							<h2 class="text-base font-semibold text-text-primary">{{ step.title }}</h2>
							<p class="mt-1 text-sm text-text-secondary">{{ step.summary }}</p>
						</div>

						<!-- 1 · Connect ------------------------------------------------ -->
						<template v-if="step.id === 'connect'">
							<p
								v-if="isKeyConnected"
								class="text-sm text-success"
								data-testid="migration-key-present"
							>
								Mailchimp Transactional is connected — Owlat can see a
								<code>MANDRILL_API_KEY</code> in this deployment's environment.
							</p>
							<div v-else class="space-y-2" data-testid="migration-key-missing">
								<p class="text-sm text-text-secondary">
									Create an API key in Mailchimp Transactional (Settings → API keys), set it as
									<code>MANDRILL_API_KEY</code> in this deployment's environment, and restart.
									Credentials never live in the database, so this page can only ever tell you
									whether the key is present — never what it is.
								</p>
								<NuxtLink
									to="/dashboard/delivery/config"
									class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-brand"
								>
									<Icon name="lucide:external-link" class="h-4 w-4" />
									Transport setup, with the paste-ready environment block
								</NuxtLink>
							</div>
						</template>

						<!-- 2 · Carry over history ------------------------------------- -->
						<DeliveryMigrationImportStep
							v-else-if="step.id === 'history' && canManageOrganization"
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
								No Mailchimp Transactional identity exists yet. Verify a sending domain on the
								domains screen first; enabling Mandrill as the fallback relay provisions the
								identity automatically, and the hourly sweep picks up the DNS from there.
							</p>
							<ul v-else class="space-y-1 text-sm" data-testid="migration-domain-checklist">
								<li
									v-for="row in domainRows"
									:key="row.domain"
									:data-testid="`migration-domain-${row.domain}`"
								>
									<span :class="row.isReady ? 'text-success' : 'text-warning'">
										{{ row.domain }}:
										{{
											row.isReady
												? 'verified and ready to relay'
												: `outstanding — ${row.outstanding.join(', ')}`
										}}
									</span>
								</li>
							</ul>
							<DeliveryMandrillDomainStatus />
							<NuxtLink
								to="/dashboard/delivery/domains"
								class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-brand"
							>
								<Icon name="lucide:globe" class="h-4 w-4" />
								Sending domains
							</NuxtLink>
						</template>

						<!-- 4 · The preset --------------------------------------------- -->
						<DeliveryMigrationPresetStep
							v-else-if="step.id === 'preset' && canManageOrganization"
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
								{{ step.blockedBy }}
							</p>
							<div v-else class="flex flex-wrap gap-4">
								<NuxtLink
									to="/dashboard/delivery/cells"
									class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-brand"
									data-testid="migration-cells-link"
								>
									<Icon name="lucide:grid-3x3" class="h-4 w-4" />
									Cells — every share, and why it moved
								</NuxtLink>
								<NuxtLink
									to="/dashboard/delivery/controls"
									class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-brand"
								>
									<Icon name="lucide:sliders-horizontal" class="h-4 w-4" />
									Ramp controls — pause, pin or promote a cell
								</NuxtLink>
								<NuxtLink
									to="/dashboard/delivery/independence"
									class="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-brand"
								>
									<Icon name="lucide:trending-up" class="h-4 w-4" />
									Independence — how much mail is already yours
								</NuxtLink>
							</div>
						</template>

						<p
							v-if="step.blockedBy && step.id !== 'watch' && !canManageOrganization"
							class="text-sm text-warning"
						>
							{{ step.blockedBy }}
						</p>
					</div>
				</div>
			</li>
		</ol>
	</div>
</template>
