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
	expectedHost: string;
	records: Array<{ priority: number; exchange: string }>;
	checkedAt: number;
} | null;

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
const paused = computed(() => move.value?.paused ?? false);

const showSection = computed(
	() => flagEnabled.value && (isLoading.value || data.value !== null || error.value !== null)
);

const address = computed(() => data.value?.address ?? '');
const domain = computed(() => data.value?.domain ?? '');
const mxHost = computed(() => data.value?.mxHost ?? null);
const mxPriority = computed(() => data.value?.mxPriority ?? 10);
const canProvisionSelf = computed(() => data.value?.canProvisionSelf ?? false);
const awaitingAdmin = computed(() => move.value?.awaitingAdminProvision ?? false);

// The exact MX record a DNS admin publishes to receive mail through Owlat.
const mxRecordLine = computed(() =>
	mxHost.value ? `${domain.value}.\t\tIN\tMX\t${mxPriority.value}\t${mxHost.value}.` : ''
);

function formatSync(ts: number | null | undefined): string {
	if (!ts) return 'never';
	return new Date(ts).toLocaleString();
}

const opError = ref<string | null>(null);
const startMove = useBackendOperation(api.mail.mailboxMove.start, {
	label: 'Start mailbox move',
	inlineTarget: opError,
});
const provisionHosted = useBackendOperation(api.mail.mailboxMove.provisionHosted, {
	label: 'Provision hosted mailbox',
	inlineTarget: opError,
});
const archiveMove = useBackendOperation(api.mail.mailboxMove.archive, {
	label: 'Archive old mailbox',
	inlineTarget: opError,
});
const pauseMove = useBackendOperation(api.mail.mailboxMove.pause, { label: 'Pause move' });
const resumeMove = useBackendOperation(api.mail.mailboxMove.resume, { label: 'Resume move' });
const cancelMove = useBackendOperation(api.mail.mailboxMove.cancel, {
	label: 'Cancel move',
	inlineTarget: opError,
});
const checkMx = useBackendOperation(api.mail.mailboxMove.checkCutoverMx, {
	label: 'Check MX',
	type: 'action',
});

const mxCheck = ref<MoveMxCheck>(null);
const showCancel = ref(false);

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
	if (res !== undefined) mxCheck.value = res;
}
async function onArchive() {
	opError.value = null;
	await archiveMove.run({});
}
async function onCancel() {
	opError.value = null;
	const res = await cancelMove.run({});
	if (res !== undefined) showCancel.value = false;
}
</script>

<template>
	<section v-if="showSection" class="card !p-0 mb-6" aria-labelledby="postbox-move-heading">
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 id="postbox-move-heading" class="font-semibold">Move this mailbox to Owlat</h2>
		</header>

		<!-- Loading -->
		<div v-if="isLoading" class="p-8 flex justify-center">
			<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
		</div>

		<!-- Error: the subscription failed. Don't silently drop the section. -->
		<div v-else-if="error" class="px-5 py-6 flex items-start gap-3" role="alert">
			<Icon name="lucide:alert-triangle" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
			<p class="text-sm text-text-secondary">
				We couldn't load your move status just now. Please refresh to try again.
			</p>
		</div>

		<template v-else-if="data">
			<div class="px-5 py-4 space-y-4">
				<p v-if="opError" class="text-sm text-error" role="alert">{{ opError }}</p>

				<!-- No move yet: the pitch + start. -->
				<template v-if="!move">
					<p class="text-sm text-text-secondary">
						Right now <code>{{ address }}</code> lives on your old provider and Owlat syncs a copy.
						Moving it here makes Owlat the real home for <code>{{ address }}</code
						>: you keep the same address, get hosted sending, and your old account stays as a
						read-only archive — nothing is deleted.
					</p>
					<p class="text-xs text-text-tertiary">
						This is a staged move you drive at your own pace. You can pause between steps, and
						nothing about how you read mail changes until you finish it.
					</p>
					<UiButton :loading="startMove.isLoading.value" @click="onStart">
						Start moving {{ address }}
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
							<p class="font-medium text-sm">Move paused</p>
							<p class="text-xs text-text-secondary mt-0.5">
								Nothing is happening until you resume. Your mailbox keeps working exactly as before.
							</p>
							<UiButton
								size="sm"
								class="mt-2"
								:loading="resumeMove.isLoading.value"
								@click="resumeMove.run({})"
							>
								Resume move
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
							<span class="font-medium text-sm">1. Provision the hosted mailbox</span>
						</div>
						<div v-if="stage === 'provisioning'" class="mt-2 pl-6">
							<p v-if="canProvisionSelf" class="text-xs text-text-secondary">
								Create the Owlat-hosted mailbox for <code>{{ address }}</code
								>. It stays empty until you point your domain's mail here in the next step.
							</p>
							<p v-else-if="awaitingAdmin" class="text-xs text-text-secondary">
								We've asked an admin to set up the hosted mailbox for <code>{{ address }}</code
								>. This step unlocks as soon as they do — you'll see it move on automatically.
							</p>
							<UiButton
								v-if="canProvisionSelf"
								size="sm"
								class="mt-2"
								:loading="provisionHosted.isLoading.value"
								@click="onProvision"
							>
								Provision hosted mailbox
							</UiButton>
						</div>
						<p v-else class="mt-1 pl-6 text-xs text-text-tertiary">
							Hosted mailbox ready for <code>{{ address }}</code
							>.
						</p>
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
							<span class="font-medium text-sm">2. Point your domain's mail (MX) at Owlat</span>
						</div>

						<div v-if="stage === 'cutover_pending'" class="mt-2 pl-6 space-y-3">
							<template v-if="mxHost">
								<p class="text-xs text-text-secondary">
									Add this MX record for <code>{{ domain }}</code> at your DNS provider. Changing MX
									needs DNS access — if that's your admin's job, hand them this exact record:
								</p>
								<div class="flex items-center gap-2">
									<code class="flex-1 min-w-0 truncate rounded bg-bg-surface px-2 py-1.5 text-xs">{{
										mxRecordLine
									}}</code>
									<button
										type="button"
										class="p-1.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-surface shrink-0"
										:title="`Copy the MX record for ${domain}`"
										:aria-label="`Copy the MX record for ${domain}`"
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
										Check propagation
									</UiButton>
									<span
										v-if="mxCheck?.verified"
										class="text-xs text-success flex items-center gap-1"
									>
										<Icon name="lucide:check-circle-2" class="w-3.5 h-3.5" />
										Mail for {{ domain }} now points at Owlat.
									</span>
									<span v-else-if="mxCheck" class="text-xs text-text-tertiary">
										Not pointing here yet — DNS can take a while to propagate. Checked
										{{ formatSync(mxCheck.checkedAt) }}.
									</span>
								</div>
								<p class="text-xs text-text-tertiary">
									Once the MX record points at Owlat, new mail lands directly in your hosted
									mailbox. Then archive your old account below.
								</p>
							</template>
							<p v-else class="text-xs text-warning">
								This instance has no inbound mail host configured, so it can't receive mail yet. An
								admin needs to set that up under Delivery before you can finish the move.
							</p>
						</div>
						<p v-else-if="stage === 'archived'" class="mt-1 pl-6 text-xs text-text-tertiary">
							Mail for <code>{{ domain }}</code> is delivered through Owlat.
						</p>
						<p v-else class="mt-1 pl-6 text-xs text-text-tertiary">
							Available once the hosted mailbox is ready.
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
							<span class="font-medium text-sm">3. Archive your old account</span>
						</div>

						<div v-if="stage === 'cutover_pending'" class="mt-2 pl-6 space-y-2">
							<p class="text-xs text-text-secondary">
								Stop syncing from your old provider and keep everything it already brought in as a
								read-only archive. Your old mail stays fully searchable — nothing is deleted. Last
								synced: {{ formatSync(data.lastSyncAt) }}.
							</p>
							<p class="text-xs text-text-tertiary">
								Do this only after mail for <code>{{ domain }}</code> points at Owlat, so no message
								slips through the gap.
							</p>
							<UiButton size="sm" :loading="archiveMove.isLoading.value" @click="onArchive">
								Archive old account
							</UiButton>
						</div>
						<div v-else-if="stage === 'archived'" class="mt-2 pl-6">
							<p class="text-xs text-text-secondary">
								Done. <code>{{ address }}</code> now lives on Owlat, and your old account is a
								read-only archive — its history is still here and searchable.
							</p>
						</div>
						<p v-else class="mt-1 pl-6 text-xs text-text-tertiary">
							The final step, once mail points here.
						</p>
					</div>

					<!-- Rollback + pause/cancel controls (hidden once complete). -->
					<template v-if="stage !== 'archived'">
						<div class="rounded-md border border-border-subtle bg-bg-surface px-4 py-3">
							<p class="text-xs text-text-tertiary">
								<strong class="text-text-secondary">Changed your mind?</strong> Cancel any time
								before you archive. Point your MX record back at your old provider and nothing is
								lost — the hosted mailbox we set up is removed and your original account keeps
								working untouched.
							</p>
						</div>
						<div class="flex items-center gap-2">
							<UiButton
								v-if="!paused"
								size="sm"
								variant="secondary"
								:loading="pauseMove.isLoading.value"
								@click="pauseMove.run({})"
							>
								Pause
							</UiButton>
							<UiButton size="sm" variant="ghost" @click="showCancel = true">Cancel move</UiButton>
						</div>
					</template>
				</template>
			</div>
		</template>

		<UiConfirmationDialog
			:open="showCancel"
			variant="danger"
			title="Cancel this move?"
			description="We'll remove the hosted mailbox we set up and leave your original account exactly as it is — still connected and syncing. Point your MX record back at your old provider if you changed it. Nothing is lost."
			confirm-text="Cancel move"
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
