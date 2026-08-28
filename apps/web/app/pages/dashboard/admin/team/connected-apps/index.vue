<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { bundledPluginComposition } from '~/plugins/plugin-composition.generated';
import { connectedAppCapabilityLabel } from '~/utils/connectedAppCapabilities';
import ConnectedAppRegisterModal from '~/components/settings/connectedApps/ConnectedAppRegisterModal.vue';
import ConnectedAppSecretReveal from '~/components/settings/connectedApps/ConnectedAppSecretReveal.vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.team.connectedApps.index.pageTitle') });
definePageMeta({ layout: 'dashboard', middleware: ['auth', 'admin'] });

// Managing connected apps requires `organization:manage`. listByTeam is
// owner/admin-gated, so surface the established "Admins only" state for editors
// and skip the query for them rather than rendering a `forbidden` throw as a
// misleading "Failed to load". `showAdminGate` only asserts once the role
// resolves, so an admin sees no flash of the gated state.
const { isAdmin, showAdminGate } = usePermissions();

const {
	data: apps,
	isLoading,
	error,
} = useConvexQuery(api.connectedApps.queries.listByTeam, () => (isAdmin.value ? {} : 'skip'));

// The plugins a new app can bind to, derived from the build-time composition.
const registrablePlugins = computed(() =>
	bundledPluginComposition.map((entry) => ({
		pluginId: entry.manifest.id,
		capabilities: entry.manifest.capabilities,
	}))
);

const { showToast } = useToast();

// Register is an action (mints + seals the secret in the Node runtime). Server
// validation errors (bad endpoint, undeclared capability) bind inline in the
// wizard rather than as a toast.
const registerError = ref<string | null>(null);
const { run: registerApp, isLoading: isRegistering } = useBackendOperation(
	api.connectedApps.actions.register,
	{
		label: () => t('dashboard.admin.team.connectedApps.index.operations.register'),
		type: 'action',
		inlineTarget: registerError,
	}
);
const { run: rotateSecret, isLoading: isRotating } = useBackendOperation(
	api.connectedApps.actions.rotateSecret,
	{
		label: () => t('dashboard.admin.team.connectedApps.index.operations.rotateSecret'),
		type: 'action',
	}
);
const { run: testConnection } = useBackendOperation(api.connectedApps.actions.testConnection, {
	label: () => t('dashboard.admin.team.connectedApps.index.operations.testConnection'),
	type: 'action',
});
const { run: enableApp } = useBackendOperation(api.connectedApps.mutations.enable, {
	label: () => t('dashboard.admin.team.connectedApps.index.operations.enable'),
});
const { run: disableApp } = useBackendOperation(api.connectedApps.mutations.disable, {
	label: () => t('dashboard.admin.team.connectedApps.index.operations.disable'),
});
const { run: revokeApp, isLoading: isRevoking } = useBackendOperation(
	api.connectedApps.mutations.revoke,
	{ label: () => t('dashboard.admin.team.connectedApps.index.operations.revoke') }
);
const { run: removeApp, isLoading: isDeleting } = useBackendOperation(
	api.connectedApps.mutations.remove,
	{ label: () => t('dashboard.admin.team.connectedApps.index.operations.delete') }
);

type ConnectedApp = NonNullable<typeof apps.value>[number];

function statusVariant(status: ConnectedApp['status']): 'success' | 'neutral' | 'error' {
	if (status === 'enabled') return 'success';
	if (status === 'disabled') return 'neutral';
	return 'error';
}
// The status vocabulary is closed (schema/plugins.ts), so each value has its own
// message rather than a title-cased echo of the stored literal.
const STATUS_LABEL_KEYS: Record<ConnectedApp['status'], string> = {
	enabled: 'common.enabled',
	disabled: 'common.disabled',
	revoked: 'dashboard.admin.team.connectedApps.index.status.revoked',
};
function statusLabel(status: ConnectedApp['status']): string {
	return t(STATUS_LABEL_KEYS[status]);
}

// ── Register + one-time secret reveal ──────────────────────────────────────
const showRegister = ref(false);
const revealed = ref<{ secret: string; appName: string; context: 'created' | 'rotated' } | null>(
	null
);

function openRegister() {
	registerError.value = null;
	showRegister.value = true;
}

async function handleRegisterSubmit(payload: {
	pluginId: string;
	name: string;
	endpointUrl: string;
	grantedCapabilities: string[];
}) {
	const created = await registerApp(payload);
	if (!created.ok) return; // failure already surfaced inline/toast
	showRegister.value = false;
	revealed.value = {
		secret: created.result.secret,
		appName: created.result.name,
		context: 'created',
	};
	showToast(
		t('dashboard.admin.team.connectedApps.index.toasts.connected', { name: created.result.name })
	);
}

// ── Rotate secret (destructive to the old secret) ──────────────────────────
const rotateTarget = ref<ConnectedApp | null>(null);
async function confirmRotate() {
	const target = rotateTarget.value;
	if (!target) return;
	const res = await rotateSecret({ connectedAppId: target._id });
	rotateTarget.value = null;
	if (!res.ok) return;
	revealed.value = { secret: res.result.secret, appName: target.name, context: 'rotated' };
}

// ── Enable / disable (reversible) ──────────────────────────────────────────
async function handleEnable(app: ConnectedApp) {
	const res = await enableApp({ connectedAppId: app._id });
	if (res.ok)
		showToast(t('dashboard.admin.team.connectedApps.index.toasts.enabled', { name: app.name }));
}
async function handleDisable(app: ConnectedApp) {
	const res = await disableApp({ connectedAppId: app._id });
	if (res.ok)
		showToast(t('dashboard.admin.team.connectedApps.index.toasts.disabled', { name: app.name }));
}

// ── Revoke / delete (destructive, confirmed) ───────────────────────────────
const revokeTarget = ref<ConnectedApp | null>(null);
const deleteTarget = ref<ConnectedApp | null>(null);
async function confirmRevoke() {
	const target = revokeTarget.value;
	if (!target) return;
	const res = await revokeApp({ connectedAppId: target._id });
	revokeTarget.value = null;
	if (res.ok)
		showToast(t('dashboard.admin.team.connectedApps.index.toasts.revoked', { name: target.name }));
}
async function confirmDelete() {
	const target = deleteTarget.value;
	if (!target) return;
	const res = await removeApp({ connectedAppId: target._id });
	deleteTarget.value = null;
	if (res.ok)
		showToast(t('dashboard.admin.team.connectedApps.index.toasts.deleted', { name: target.name }));
}

// ── Connection test ────────────────────────────────────────────────────────
type TestResult = BackendOperationValue<ReturnType<typeof testConnection>>;
const testResults = ref<Record<string, TestResult>>({});
const testingId = ref<Id<'connectedApps'> | null>(null);

async function runTest(app: ConnectedApp) {
	testingId.value = app._id;
	const result = await testConnection({ connectedAppId: app._id });
	testingId.value = null;
	if (!result.ok) return; // transport failure already toasted
	testResults.value = { ...testResults.value, [app._id]: result.result };
}
function testTone(outcome: TestResult['outcome']): string {
	if (outcome === 'ok') return 'text-success';
	if (outcome === 'error_status') return 'text-warning';
	return 'text-error';
}
function testIcon(outcome: TestResult['outcome']): string {
	if (outcome === 'ok') return 'lucide:check-circle';
	if (outcome === 'error_status') return 'lucide:alert-triangle';
	return 'lucide:x-circle';
}
</script>

<template>
	<div class="p-6 lg:p-8 max-w-4xl mx-auto">
		<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
			<div>
				<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
					{{ t('dashboard.admin.team.connectedApps.index.title') }}
				</h1>
				<p class="mt-1 text-text-secondary max-w-2xl">
					{{ t('dashboard.admin.team.connectedApps.index.intro') }}
				</p>
			</div>
			<UiButton v-if="!showAdminGate" variant="primary" class="shrink-0" @click="openRegister">
				<Icon name="lucide:plus" class="w-4 h-4" />
				{{ t('dashboard.admin.team.connectedApps.index.connect') }}
			</UiButton>
		</div>

		<!-- Admins-only gate: editors lack organization:manage. -->
		<UiCard
			v-if="showAdminGate"
			class="flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:lock" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">
				{{ t('dashboard.admin.team.connectedApps.index.adminGate.title') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				{{ t('dashboard.admin.team.connectedApps.index.adminGate.description') }}
			</p>
		</UiCard>

		<UiQueryBoundary v-else :loading="isLoading && !apps" :error="error">
			<!-- Empty -->
			<UiCard v-if="!apps || apps.length === 0">
				<UiEmptyState
					icon="lucide:plug"
					:title="t('dashboard.admin.team.connectedApps.index.empty.title')"
					:description="t('dashboard.admin.team.connectedApps.index.empty.description')"
				>
					<UiButton variant="secondary" @click="openRegister">
						<Icon name="lucide:plus" class="w-4 h-4" />
						{{ t('dashboard.admin.team.connectedApps.index.connect') }}
					</UiButton>
				</UiEmptyState>
			</UiCard>

			<div v-else class="grid gap-4">
				<UiCard v-for="app in apps" :key="app._id">
					<div class="flex flex-col gap-4">
						<div class="flex items-start justify-between gap-4">
							<div class="min-w-0">
								<div class="flex items-center gap-2 flex-wrap">
									<h2 class="text-lg font-medium text-text-primary truncate">{{ app.name }}</h2>
									<UiBadge :variant="statusVariant(app.status)" dot>
										{{ statusLabel(app.status) }}
									</UiBadge>
								</div>
								<p class="text-sm text-text-secondary mt-0.5">{{ app.pluginId }}</p>
								<p class="text-xs text-text-tertiary mt-1 font-mono break-all">
									{{ app.endpointUrl }}
								</p>
							</div>
						</div>

						<!-- Granted capabilities -->
						<div v-if="app.grantedCapabilities.length > 0" class="flex flex-wrap gap-1.5">
							<span
								v-for="capability in app.grantedCapabilities"
								:key="capability"
								class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-bg-surface border border-border-subtle text-xs text-text-secondary"
								:title="capability"
							>
								{{ connectedAppCapabilityLabel(capability) }}
							</span>
						</div>

						<!--
							Connection test result. The role="status" live region is rendered
							persistently (only its inner content toggles) so screen readers
							reliably announce the outcome — a live region announces a mutation
							only if it already existed in the DOM before the change. It is
							visually collapsed (sr-only) until there is something to show.
						-->
						<p
							role="status"
							aria-live="polite"
							class="flex items-start gap-2 text-sm"
							:class="[
								testResults[app._id]
									? testTone(testResults[app._id]!.outcome)
									: 'text-text-secondary',
								!testResults[app._id] && testingId !== app._id ? 'sr-only' : '',
							]"
						>
							<template v-if="testingId === app._id">
								<Icon name="lucide:loader-2" class="w-4 h-4 shrink-0 mt-0.5 animate-spin motion-reduce:animate-none" />
								<span>{{ t('dashboard.admin.team.connectedApps.index.testing') }}</span>
							</template>
							<template v-else-if="testResults[app._id]">
								<Icon
									:name="testIcon(testResults[app._id]!.outcome)"
									class="w-4 h-4 shrink-0 mt-0.5"
								/>
								<span>{{ testResults[app._id]!.message }}</span>
							</template>
						</p>

						<!-- Actions -->
						<div class="flex flex-wrap items-center gap-2 pt-1 border-t border-border-subtle mt-1">
							<UiButton
								v-if="app.status !== 'revoked'"
								variant="secondary"
								size="sm"
								:loading="testingId === app._id"
								@click="runTest(app)"
							>
								<Icon name="lucide:activity" class="w-4 h-4" />
								{{ t('dashboard.admin.team.connectedApps.index.testConnection') }}
							</UiButton>
							<UiButton
								v-if="app.status === 'disabled'"
								variant="secondary"
								size="sm"
								@click="handleEnable(app)"
							>
								{{ t('dashboard.admin.team.connectedApps.index.enable') }}
							</UiButton>
							<UiButton
								v-else-if="app.status === 'enabled'"
								variant="secondary"
								size="sm"
								@click="handleDisable(app)"
							>
								{{ t('dashboard.admin.team.connectedApps.index.disable') }}
							</UiButton>
							<UiButton
								v-if="app.status !== 'revoked'"
								variant="secondary"
								size="sm"
								@click="rotateTarget = app"
							>
								{{ t('dashboard.admin.team.connectedApps.index.rotateSecret') }}
							</UiButton>
							<span class="flex-1"></span>
							<UiButton
								v-if="app.status !== 'revoked'"
								variant="ghost"
								size="sm"
								class="text-warning"
								@click="revokeTarget = app"
							>
								{{ t('dashboard.admin.team.connectedApps.index.revoke') }}
							</UiButton>
							<UiButton variant="ghost" size="sm" class="text-error" @click="deleteTarget = app">
								{{ t('common.delete') }}
							</UiButton>
						</div>
					</div>
				</UiCard>
			</div>
		</UiQueryBoundary>

		<!-- Register wizard -->
		<ConnectedAppRegisterModal
			:open="showRegister"
			:plugins="registrablePlugins"
			:is-submitting="isRegistering"
			:error-message="registerError"
			@close="showRegister = false"
			@submit="handleRegisterSubmit"
		/>

		<!-- One-time secret reveal (register + rotate) -->
		<ConnectedAppSecretReveal
			:open="!!revealed"
			:secret="revealed?.secret ?? null"
			:app-name="revealed?.appName ?? null"
			:context="revealed?.context ?? 'created'"
			@close="revealed = null"
		/>

		<!-- Rotate confirmation -->
		<UiConfirmationDialog
			:open="!!rotateTarget"
			variant="warning"
			:title="
				rotateTarget
					? t('dashboard.admin.team.connectedApps.index.rotateDialog.title', {
							name: rotateTarget.name,
						})
					: t('dashboard.admin.team.connectedApps.index.rotateDialog.titleFallback')
			"
			:description="t('dashboard.admin.team.connectedApps.index.rotateDialog.description')"
			:confirm-text="t('dashboard.admin.team.connectedApps.index.rotateSecret')"
			:cancel-text="t('common.cancel')"
			:is-loading="isRotating"
			@update:open="(v: boolean) => !v && (rotateTarget = null)"
			@confirm="confirmRotate"
		/>

		<!-- Revoke confirmation -->
		<UiConfirmationDialog
			:open="!!revokeTarget"
			variant="warning"
			:title="
				revokeTarget
					? t('dashboard.admin.team.connectedApps.index.revokeDialog.title', {
							name: revokeTarget.name,
						})
					: t('dashboard.admin.team.connectedApps.index.revokeDialog.titleFallback')
			"
			:description="t('dashboard.admin.team.connectedApps.index.revokeDialog.description')"
			:confirm-text="t('dashboard.admin.team.connectedApps.index.revokeDialog.confirm')"
			:cancel-text="t('common.cancel')"
			:is-loading="isRevoking"
			@update:open="(v: boolean) => !v && (revokeTarget = null)"
			@confirm="confirmRevoke"
		/>

		<!-- Delete confirmation -->
		<UiConfirmationDialog
			:open="!!deleteTarget"
			variant="danger"
			:title="
				deleteTarget
					? t('dashboard.admin.team.connectedApps.index.deleteDialog.title', {
							name: deleteTarget.name,
						})
					: t('dashboard.admin.team.connectedApps.index.deleteDialog.titleFallback')
			"
			:description="t('dashboard.admin.team.connectedApps.index.deleteDialog.description')"
			:confirm-text="t('dashboard.admin.team.connectedApps.index.deleteDialog.confirm')"
			:cancel-text="t('common.cancel')"
			:is-loading="isDeleting"
			@update:open="(v: boolean) => !v && (deleteTarget = null)"
			@confirm="confirmDelete"
		/>
	</div>
</template>
