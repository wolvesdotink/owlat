<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { McpClientAccess } from '~/composables/useMcpClients';
import { CheckIcon, CopyIcon, PlusIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.preferences.aiClients.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
	requiresFeature: 'mail.mcp',
});

const { clients, isLoading, error, refetch, serverUrl, create, revoke } = useMcpClients();
const {
	pending,
	isLoading: isPendingLoading,
	error: pendingError,
	refetch: refetchPending,
	busyId,
	notices,
	approve,
	reject,
} = useMcpPendingActions();
const { copy, copiedKey } = useCopyToClipboard();

// The quiet "nothing is waiting" line (and its first load) sits below the
// setup card; anything that still needs an answer, or a read that failed,
// moves above it.
const approvalsLead = computed(
	() => !isPendingLoading.value && (!!pendingError.value || pending.value.length > 0)
);

const showCreate = ref(false);
const isCreating = ref(false);
const reveal = ref<{ token: string; label: string } | null>(null);
const expandedClientId = ref<Id<'mcpClients'> | null>(null);

async function handleCreate(input: {
	label: string;
	mailboxIds: Id<'mailboxes'>[];
	access: McpClientAccess;
}) {
	isCreating.value = true;
	try {
		const result = await create(input.label, input.mailboxIds, input.access);
		if (!result.ok) return;
		showCreate.value = false;
		reveal.value = { token: result.result.token, label: input.label };
	} finally {
		isCreating.value = false;
	}
}

const clientToRevoke = ref<Id<'mcpClients'> | null>(null);
const isRevoking = ref(false);

async function confirmRevoke() {
	const id = clientToRevoke.value;
	if (!id) return;
	isRevoking.value = true;
	try {
		await revoke(id);
	} finally {
		isRevoking.value = false;
		clientToRevoke.value = null;
	}
}

function toggleActivity(id: Id<'mcpClients'>) {
	expandedClientId.value = expandedClientId.value === id ? null : id;
}

function formatTime(ts?: number) {
	if (!ts) return t('common.never');
	return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
		ts
	);
}
</script>

<template>
	<div>
		<header
			class="mb-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
		>
			<p class="text-text-secondary">{{ t('dashboard.preferences.aiClients.subheading') }}</p>
			<UiButton type="button" class="shrink-0" @click="showCreate = true">
				<PlusIcon class="w-4 h-4 mr-1.5" />
				{{ t('dashboard.preferences.aiClients.connect') }}
			</UiButton>
		</header>

		<!-- Approvals wait on the user, so they lead the page whenever any are open. -->
		<section v-if="approvalsLead" id="approvals" class="card !p-0 mb-6">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">{{ t('dashboard.preferences.aiClients.approvalsHeading') }}</h2>
			</header>
			<UiQueryBoundary v-if="pendingError" :error="pendingError" @retry="refetchPending" />
			<div v-else class="p-4 space-y-3">
				<LazyPreferencesMcpPendingActionCard
					v-for="action in pending"
					:key="action._id"
					:action="action"
					:busy="busyId === action._id"
					:notice="notices[action._id]"
					@approve="(reviewDigest) => approve(action._id, reviewDigest)"
					@reject="reject(action._id)"
				/>
			</div>
		</section>

		<section class="card !p-0 mb-6">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">{{ t('dashboard.preferences.aiClients.serverHeading') }}</h2>
			</header>
			<div class="px-5 py-4 text-sm space-y-3">
				<div class="flex items-center gap-2">
					<code class="font-mono break-all flex-1 min-w-0">{{ serverUrl }}</code>
					<UiButton variant="ghost" type="button" @click="copy(serverUrl, 'mcp-server-url')">
						<component
							:is="copiedKey === 'mcp-server-url' ? CheckIcon : CopyIcon"
							class="w-4 h-4 mr-1.5"
						/>
						{{ copiedKey === 'mcp-server-url' ? t('common.copied') : t('common.copy') }}
					</UiButton>
				</div>
				<p class="text-text-secondary">{{ t('dashboard.preferences.aiClients.accessNote') }}</p>
			</div>
		</section>

		<section v-if="!approvalsLead" id="approvals" class="card !p-0 mb-6">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">{{ t('dashboard.preferences.aiClients.approvalsHeading') }}</h2>
			</header>
			<div v-if="isPendingLoading" class="p-8 flex justify-center">
				<SpinnerIcon class="w-5 h-5 text-text-tertiary" />
			</div>
			<p v-else class="px-5 py-4 text-sm text-text-secondary">
				{{ t('dashboard.preferences.aiClients.approvalsEmpty') }}
			</p>
		</section>

		<section class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">{{ t('dashboard.preferences.aiClients.clientsHeading') }}</h2>
			</header>
			<div v-if="isLoading" class="p-8 flex justify-center">
				<SpinnerIcon class="w-5 h-5 text-text-tertiary" />
			</div>
			<UiQueryBoundary v-else-if="error" :error="error" @retry="refetch" />
			<div v-else-if="clients.length === 0" class="p-8 text-center text-text-secondary">
				{{ t('dashboard.preferences.aiClients.empty') }}
			</div>
			<ul v-else class="divide-y divide-border-subtle">
				<li v-for="client in clients" :key="client._id" class="px-5 py-3">
					<div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class="font-medium break-words">{{ client.label }}</span>
								<span class="text-xs text-text-tertiary font-mono">{{ client.tokenPrefix }}…</span>
								<UiBadge v-if="client.revokedAt" variant="error">{{
									t('dashboard.preferences.aiClients.revoked')
								}}</UiBadge>
								<UiBadge variant="neutral">{{
									client.access === 'read_write'
										? t('dashboard.preferences.aiClients.readWrite')
										: t('dashboard.preferences.aiClients.readOnly')
								}}</UiBadge>
							</div>
							<p class="text-xs text-text-secondary mt-1 break-words">
								<template v-for="(mailbox, index) in client.mailboxes" :key="mailbox.mailboxId">
									<span v-if="index > 0"> · </span>
									<span v-if="mailbox.isAvailable">{{ mailbox.address }}</span>
									<span v-else class="text-text-tertiary">{{
										t('dashboard.preferences.aiClients.mailboxUnavailable')
									}}</span>
								</template>
							</p>
							<p class="text-xs text-text-tertiary mt-0.5">
								{{
									t('dashboard.preferences.aiClients.usageLine', {
										created: formatTime(client.createdAt),
										lastUsed: formatTime(client.lastUsedAt),
									})
								}}
							</p>
						</div>
						<div class="flex items-center gap-1 shrink-0">
							<UiButton
								variant="ghost"
								type="button"
								:aria-expanded="expandedClientId === client._id"
								:aria-label="
									t('dashboard.preferences.aiClients.activityNamed', { name: client.label })
								"
								@click="toggleActivity(client._id)"
							>
								{{ t('dashboard.preferences.aiClients.activity') }}
							</UiButton>
							<UiButton
								v-if="!client.revokedAt"
								variant="danger-ghost"
								type="button"
								:aria-label="
									t('dashboard.preferences.aiClients.revokeNamed', { name: client.label })
								"
								@click="clientToRevoke = client._id"
							>
								{{ t('dashboard.preferences.aiClients.revoke') }}
							</UiButton>
						</div>
					</div>
					<PreferencesMcpClientActivity
						v-if="expandedClientId === client._id"
						:client-id="client._id"
						class="mt-3"
					/>
				</li>
			</ul>
		</section>

		<PreferencesMcpClientCreateDialog
			v-if="showCreate"
			:busy="isCreating"
			@cancel="showCreate = false"
			@submit="handleCreate"
		/>

		<PreferencesMcpClientTokenReveal
			:open="reveal !== null"
			:token="reveal?.token ?? null"
			:label="reveal?.label ?? null"
			:server-url="serverUrl"
			@update:open="(v: boolean) => !v && (reveal = null)"
		/>

		<UiConfirmationDialog
			:open="!!clientToRevoke"
			variant="danger"
			:title="t('dashboard.preferences.aiClients.revokeDialogTitle')"
			:description="t('dashboard.preferences.aiClients.revokeDialogDescription')"
			:confirm-text="t('dashboard.preferences.aiClients.revoke')"
			:is-loading="isRevoking"
			@update:open="(v: boolean) => !v && (clientToRevoke = null)"
			@confirm="confirmRevoke"
		/>
	</div>
</template>
