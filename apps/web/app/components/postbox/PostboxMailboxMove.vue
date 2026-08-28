<script setup lang="ts">
/**
 * Postbox → "Move my mailbox here" (piece c5).
 *
 * The staged full move of a connected external mailbox onto an Owlat-hosted
 * mailbox on the SAME address. Three stages the user drives at their own pace:
 *
 *   1. Provision  — stand up a hosted mailbox for the address (admin-only, so a
 *                   non-admin sees "waiting for an admin" while the request is open).
 *   2. Point MX   — publish the inbound MX record and watch it propagate live.
 *   3. Archive    — demote the old external account to a READ-ONLY archive:
 *                   sync stops, the history stays, nothing is deleted.
 *
 * Fail-soft at every step — the current truth (last sync, live MX state) is
 * shown, never assumed — and the whole thing pauses/resumes. Rollback is spelled
 * out in-flow: cancel before archiving and repointing MX back loses nothing.
 *
 * Rendered only when the caller actually has a connected external mailbox; a
 * hosted-only user has nothing to move, so the section self-hides.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

type MoveMxCheck = {
	verified: boolean;
	checkedAt: number;
} | null;

const { t, locale } = useI18n();

// `mail.external` is OFF by default. The backend query asserts the flag and
// throws for a flag-off instance, so skip the subscription entirely when off.
const { isEnabled } = useFeatureFlag();
const flagEnabled = computed(() => isEnabled('mail.external'));

const {
	data: status,
	isLoading,
	error,
} = useConvexQuery(api.mail.mailboxMove.moveStatus, () => (flagEnabled.value ? {} : 'skip'));

const { copy, isCopied } = useCopyToClipboard();

// Narrow the discriminated union once, in the script, so the template only ever
// touches plain primitives.
const data = computed(() => (status.value?.eligible ? status.value : null));
const move = computed(() => data.value?.move ?? null);
const stage = computed(() => move.value?.stage ?? null);
const paused = computed(() => move.value?.isPaused ?? false);

const showSection = computed(
	() => flagEnabled.value && (isLoading.value || data.value !== null || error.value !== null)
);

const address = computed(() => data.value?.address ?? '');
const domain = computed(() => data.value?.domain ?? '');
const mxHost = computed(() => data.value?.mxHost ?? null);
const mxPriority = computed(() => data.value?.mxPriority);
const canProvisionSelf = computed(() => data.value?.canProvisionSelf ?? false);
const awaitingAdmin = computed(() => move.value?.awaitingAdminProvision ?? false);

// The exact MX record a DNS admin publishes to receive mail through Owlat.
const mxRecordLine = computed(() =>
	mxHost.value ? `${domain.value}.\t\tIN\tMX\t${mxPriority.value}\t${mxHost.value}.` : ''
);

function formatTimestamp(ts: number | null | undefined): string {
	if (!ts) return t('components.postbox.postboxMailboxMove.never');
	return new Date(ts).toLocaleString(locale.value);
}

const opError = ref<string | null>(null);
const startMove = useBackendOperation(api.mail.mailboxMove.start, {
	label: () => t('components.postbox.postboxMailboxMove.operations.start'),
	inlineTarget: opError,
});
const provisionHosted = useBackendOperation(api.mail.mailboxMove.provisionHosted, {
	label: () => t('components.postbox.postboxMailboxMove.operations.provision'),
	inlineTarget: opError,
});
const archiveMove = useBackendOperation(api.mail.mailboxMove.archive, {
	label: () => t('components.postbox.postboxMailboxMove.operations.archive'),
	inlineTarget: opError,
});
const pauseMove = useBackendOperation(api.mail.mailboxMove.pause, {
	label: () => t('components.postbox.postboxMailboxMove.operations.pause'),
});
const resumeMove = useBackendOperation(api.mail.mailboxMove.resume, {
	label: () => t('components.postbox.postboxMailboxMove.operations.resume'),
});
const cancelMove = useBackendOperation(api.mail.mailboxMove.cancel, {
	label: () => t('components.postbox.postboxMailboxMove.operations.cancel'),
	inlineTarget: opError,
});
const checkMx = useBackendOperation(api.mail.mailboxMoveActions.checkCutoverMx, {
	label: () => t('components.postbox.postboxMailboxMove.operations.checkMx'),
	type: 'action',
});

const mxCheck = ref<MoveMxCheck>(null);
const showCancel = ref(false);
const dnsDetailsOpen = ref(false);

async function onStart() {
	opError.value = null;
	await startMove.run({});
}
async function onProvision() {
	if (!move.value) return;
	opError.value = null;
	await provisionHosted.run({ moveId: move.value.id as Id<'mailboxMoves'> });
}
async function onCheckMx() {
	const res = await checkMx.run({});
	if (res.ok) mxCheck.value = res.result;
}
async function onArchive() {
	opError.value = null;
	// A stale "points at Owlat" verdict must not survive into the archived state.
	mxCheck.value = null;
	await archiveMove.run({});
}
async function onCancel() {
	opError.value = null;
	const res = await cancelMove.run({});
	if (res.ok) {
		// Clear the verdict so a fresh move doesn't resurface the old result.
		mxCheck.value = null;
		showCancel.value = false;
	}
}
</script>

<template>
	<section v-if="showSection" class="card !p-0 mb-6" aria-labelledby="postbox-move-heading">
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 id="postbox-move-heading" class="font-semibold">
				{{ t('components.postbox.postboxMailboxMove.heading') }}
			</h2>
		</header>

		<!-- Loading -->
		<div v-if="isLoading" class="p-8 flex justify-center">
			<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
		</div>

		<!-- Error: the subscription failed. Don't silently drop the section. -->
		<div v-else-if="error" class="px-5 py-6 flex items-start gap-3" role="alert">
			<Icon name="lucide:alert-triangle" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
			<p class="text-sm text-text-secondary">
				{{ t('components.postbox.postboxMailboxMove.loadError') }}
			</p>
		</div>

		<template v-else-if="data">
			<div class="px-5 py-4 space-y-4">
				<p v-if="opError" class="text-sm text-error" role="alert">{{ opError }}</p>

				<!-- No move yet: the pitch + start. -->
				<template v-if="!move">
					<I18nT
						keypath="components.postbox.postboxMailboxMove.pitch"
						tag="p"
						scope="global"
						class="text-sm text-text-secondary"
					>
						<template #address>
							<code>{{ address }}</code>
						</template>
					</I18nT>
					<p class="text-xs text-text-tertiary">
						{{ t('components.postbox.postboxMailboxMove.pace') }}
					</p>
					<UiButton :loading="startMove.isLoading.value" @click="onStart">
						{{ t('components.postbox.postboxMailboxMove.start', { address }) }}
					</UiButton>
				</template>

				<!-- A move is underway: the stepper. -->
				<template v-else>
					<div
						v-if="paused"
						class="rounded-md border border-warning/30 bg-warning-subtle px-4 py-3 flex items-start gap-3"
					>
						<Icon name="lucide:pause" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
						<div class="min-w-0">
							<p class="font-medium text-sm">
								{{ t('components.postbox.postboxMailboxMove.paused.title') }}
							</p>
							<p class="text-xs text-text-secondary mt-0.5">
								{{ t('components.postbox.postboxMailboxMove.paused.body') }}
							</p>
							<UiButton
								size="sm"
								class="mt-2"
								:loading="resumeMove.isLoading.value"
								@click="resumeMove.run({})"
							>
								{{ t('components.postbox.postboxMailboxMove.paused.resume') }}
							</UiButton>
						</div>
					</div>

					<!-- Stage 1 — Provision -->
					<div class="rounded-md border border-border-subtle px-4 py-3">
						<div class="flex items-center gap-2">
							<Icon
								:name="stage === 'provisioning' ? 'lucide:loader-2' : 'lucide:check-circle-2'"
								class="w-4 h-4 shrink-0"
								:class="stage === 'provisioning' ? 'text-brand' : 'text-success'"
							/>
							<span class="font-medium text-sm">
								{{ t('components.postbox.postboxMailboxMove.stage1.title') }}
							</span>
						</div>
						<div v-if="stage === 'provisioning'" class="mt-2 pl-6">
							<I18nT
								v-if="canProvisionSelf"
								keypath="components.postbox.postboxMailboxMove.stage1.self"
								tag="p"
								scope="global"
								class="text-xs text-text-secondary"
							>
								<template #address>
									<code>{{ address }}</code>
								</template>
							</I18nT>
							<I18nT
								v-else-if="awaitingAdmin"
								keypath="components.postbox.postboxMailboxMove.stage1.awaitingAdmin"
								tag="p"
								scope="global"
								class="text-xs text-text-secondary"
							>
								<template #address>
									<code>{{ address }}</code>
								</template>
							</I18nT>
							<UiButton
								v-if="canProvisionSelf"
								size="sm"
								class="mt-2"
								:loading="provisionHosted.isLoading.value"
								@click="onProvision"
							>
								{{ t('components.postbox.postboxMailboxMove.stage1.action') }}
							</UiButton>
						</div>
						<I18nT
							v-else
							keypath="components.postbox.postboxMailboxMove.stage1.ready"
							tag="p"
							scope="global"
							class="mt-1 pl-6 text-xs text-text-tertiary"
						>
							<template #address>
								<code>{{ address }}</code>
							</template>
						</I18nT>
					</div>

					<!-- Stage 2 — Point MX -->
					<div
						class="rounded-md border px-4 py-3"
						:class="
							stage === 'cutover_pending'
								? 'border-brand/40 bg-brand-subtle'
								: 'border-border-subtle'
						"
					>
						<div class="flex items-center gap-2">
							<Icon
								:name="stage === 'archived' ? 'lucide:check-circle-2' : 'lucide:globe'"
								class="w-4 h-4 shrink-0"
								:class="stage === 'archived' ? 'text-success' : 'text-text-secondary'"
							/>
							<span class="font-medium text-sm">
								{{ t('components.postbox.postboxMailboxMove.stage2.title') }}
							</span>
						</div>

						<div v-if="stage === 'cutover_pending'" class="mt-2 pl-6 space-y-3">
							<p class="text-xs text-text-secondary">
								{{ t('components.postbox.postboxMailboxMove.stage2.body') }}
							</p>
							<UiDisclosure
								v-if="mxHost"
								v-model="dnsDetailsOpen"
								:label="t('components.postbox.postboxMailboxMove.stage2.advanced')"
							>
								<I18nT
									keypath="components.postbox.postboxMailboxMove.stage2.recordIntro"
									tag="p"
									scope="global"
									class="text-xs text-text-secondary"
								>
									<template #domain>
										<code>{{ domain }}</code>
									</template>
								</I18nT>
								<div class="flex items-center gap-2">
									<code class="flex-1 min-w-0 truncate rounded bg-bg-surface px-2 py-1.5 text-xs">{{
										mxRecordLine
									}}</code>
									<button
										type="button"
										class="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface shrink-0"
										:title="
											t('components.postbox.postboxMailboxMove.stage2.copyRecord', { domain })
										"
										:aria-label="
											t('components.postbox.postboxMailboxMove.stage2.copyRecord', { domain })
										"
										@click="copy(mxRecordLine, 'mx')"
									>
										<Icon :name="isCopied('mx') ? 'lucide:check' : 'lucide:copy'" class="w-4 h-4" />
									</button>
								</div>
								<div class="flex items-center gap-2 flex-wrap">
									<UiButton
										size="sm"
										variant="secondary"
										:loading="checkMx.isLoading.value"
										@click="onCheckMx"
									>
										{{ t('components.postbox.postboxMailboxMove.stage2.checkPropagation') }}
									</UiButton>
									<span
										v-if="mxCheck?.verified"
										class="text-xs text-success flex items-center gap-1"
									>
										<Icon name="lucide:check-circle-2" class="w-3.5 h-3.5" />
										{{ t('components.postbox.postboxMailboxMove.stage2.pointsHere', { domain }) }}
									</span>
									<span v-else-if="mxCheck" class="text-xs text-text-tertiary">
										{{
											t('components.postbox.postboxMailboxMove.stage2.notPointing', {
												checked: formatTimestamp(mxCheck.checkedAt),
											})
										}}
									</span>
								</div>
								<p class="text-xs text-text-tertiary">
									{{ t('components.postbox.postboxMailboxMove.stage2.afterMx') }}
								</p>
							</UiDisclosure>
							<p v-else class="text-xs text-warning">
								{{ t('components.postbox.postboxMailboxMove.stage2.noInboundHost') }}
							</p>
						</div>
						<I18nT
							v-else-if="stage === 'archived'"
							keypath="components.postbox.postboxMailboxMove.stage2.delivered"
							tag="p"
							scope="global"
							class="mt-1 pl-6 text-xs text-text-tertiary"
						>
							<template #domain>
								<code>{{ domain }}</code>
							</template>
						</I18nT>
						<p v-else class="mt-1 pl-6 text-xs text-text-tertiary">
							{{ t('components.postbox.postboxMailboxMove.stage2.locked') }}
						</p>
					</div>

					<!-- Stage 3 — Archive -->
					<div
						class="rounded-md border px-4 py-3"
						:class="
							stage === 'archived' ? 'border-success/40 bg-success-subtle' : 'border-border-subtle'
						"
					>
						<div class="flex items-center gap-2">
							<Icon
								:name="stage === 'archived' ? 'lucide:check-circle-2' : 'lucide:archive'"
								class="w-4 h-4 shrink-0"
								:class="stage === 'archived' ? 'text-success' : 'text-text-secondary'"
							/>
							<span class="font-medium text-sm">
								{{ t('components.postbox.postboxMailboxMove.stage3.title') }}
							</span>
						</div>

						<div v-if="stage === 'cutover_pending'" class="mt-2 pl-6 space-y-2">
							<p class="text-xs text-text-secondary">
								{{
									t('components.postbox.postboxMailboxMove.stage3.body', {
										lastSync: formatTimestamp(data.lastSyncAt),
									})
								}}
							</p>
							<I18nT
								keypath="components.postbox.postboxMailboxMove.stage3.warning"
								tag="p"
								scope="global"
								class="text-xs text-text-tertiary"
							>
								<template #domain>
									<code>{{ domain }}</code>
								</template>
							</I18nT>
							<UiButton size="sm" :loading="archiveMove.isLoading.value" @click="onArchive">
								{{ t('components.postbox.postboxMailboxMove.stage3.action') }}
							</UiButton>
						</div>
						<div v-else-if="stage === 'archived'" class="mt-2 pl-6">
							<I18nT
								keypath="components.postbox.postboxMailboxMove.stage3.done"
								tag="p"
								scope="global"
								class="text-xs text-text-secondary"
							>
								<template #address>
									<code>{{ address }}</code>
								</template>
							</I18nT>
						</div>
						<p v-else class="mt-1 pl-6 text-xs text-text-tertiary">
							{{ t('components.postbox.postboxMailboxMove.stage3.locked') }}
						</p>
					</div>

					<!-- Rollback + pause/cancel controls (hidden once complete). -->
					<template v-if="stage !== 'archived'">
						<div class="rounded-md border border-border-subtle bg-bg-surface px-4 py-3">
							<I18nT
								keypath="components.postbox.postboxMailboxMove.rollback.body"
								tag="p"
								scope="global"
								class="text-xs text-text-tertiary"
							>
								<template #lead>
									<strong class="text-text-secondary">
										{{ t('components.postbox.postboxMailboxMove.rollback.lead') }}
									</strong>
								</template>
							</I18nT>
						</div>
						<div class="flex items-center gap-2">
							<UiButton
								v-if="!paused"
								size="sm"
								variant="secondary"
								:loading="pauseMove.isLoading.value"
								@click="pauseMove.run({})"
							>
								{{ t('components.postbox.postboxMailboxMove.pause') }}
							</UiButton>
							<UiButton size="sm" variant="ghost" @click="showCancel = true">
								{{ t('components.postbox.postboxMailboxMove.cancelMove') }}
							</UiButton>
						</div>
					</template>
				</template>
			</div>
		</template>

		<UiConfirmationDialog
			:open="showCancel"
			variant="danger"
			:title="t('components.postbox.postboxMailboxMove.cancelDialog.title')"
			:description="t('components.postbox.postboxMailboxMove.cancelDialog.description')"
			:confirm-text="t('components.postbox.postboxMailboxMove.cancelMove')"
			:is-loading="cancelMove.isLoading.value"
			@update:open="
				(v: boolean) => {
					if (!v) showCancel = false;
				}
			"
			@confirm="onCancel"
		/>
	</section>
</template>
