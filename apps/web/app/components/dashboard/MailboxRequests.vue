<script setup lang="ts">
/**
 * Admin surfacing point for mailbox requests (pieces c3 + a4).
 *
 * A member who hits the fresh-start dead-end (no mailbox, nothing they can do
 * alone) asks an admin in-app via `mail.mailboxRequest.request`. Those open
 * requests land here on the dashboard — where every admin already looks — so the
 * ask isn't lost in an email.
 *
 * Each row closes the loop two ways:
 *   - "Provision now" stands the hosted mailbox up straight from the request
 *     (`provisionFromRequest`) through the shared admin provisioning path and
 *     resolves the request as FULFILLED — the requester is admitted to their
 *     inbox. Disabled with a one-line reason when hosted mail isn't configured.
 *   - "Mark done" is the plain acknowledge/decline for the cases where no hosted
 *     mailbox is provisioned here (the requester connects an external account,
 *     or the admin handled it elsewhere).
 *
 * Only rendered for admins by the parent; the backend also gates every read and
 * write on `requireAdminContext`, so this is defence-in-depth, not the fence.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { data: requests, isLoading } = useConvexQuery(
	api.mail.mailboxRequest.listPending,
	() => ({})
);

// Hosted mailboxes can only be provisioned once at least one sending domain is
// verified — the same signal the "add mailbox" flow keys off. No verified
// domain ⇒ hosted mail isn't configured, so "Provision now" is disabled.
const { data: verifiedDomains } = useConvexQuery(api.domains.domains.listVerified, () => ({}));
const hostedConfigured = computed(() => (verifiedDomains.value?.length ?? 0) > 0);

const { run: provisionRequest } = useBackendOperation(
	api.mail.mailboxRequest.provisionFromRequest,
	{ label: 'Provision mailbox' }
);
const { run: resolveRequest } = useBackendOperation(api.mail.mailboxRequest.resolve, {
	label: 'Resolve mailbox request',
});

const openRequests = computed(() => requests.value ?? []);

// Which row is mid-action, and which action, so only that button spins.
const busy = ref<{ id: Id<'mailboxRequests'>; action: 'provision' | 'resolve' } | null>(null);

async function provision(requestId: Id<'mailboxRequests'>) {
	if (busy.value || !hostedConfigured.value) return;
	busy.value = { id: requestId, action: 'provision' };
	try {
		await provisionRequest({ requestId });
	} finally {
		busy.value = null;
	}
}

async function resolve(requestId: Id<'mailboxRequests'>) {
	if (busy.value) return;
	busy.value = { id: requestId, action: 'resolve' };
	try {
		await resolveRequest({ requestId });
	} finally {
		busy.value = null;
	}
}
</script>

<template>
	<div v-if="!isLoading && openRequests.length" class="card mb-8">
		<div class="flex items-center gap-3 mb-4">
			<UiIconBox icon="lucide:mailbox" variant="surface" />
			<div>
				<h2 class="text-lg font-semibold text-text-primary">Mailbox requests</h2>
				<p class="text-sm text-text-secondary mt-0.5">
					{{ openRequests.length }} teammate{{ openRequests.length === 1 ? '' : 's' }} need a
					mailbox. Provision one straight from the request, or mark it done if you've handled it
					another way.
				</p>
			</div>
		</div>

		<ul class="space-y-2">
			<li
				v-for="req in openRequests"
				:key="req.id"
				class="flex items-center justify-between gap-4 rounded-xl border border-border-subtle bg-bg-surface/50 px-4 py-3"
			>
				<div class="min-w-0">
					<p class="font-medium text-text-primary truncate">{{ req.name || req.email }}</p>
					<p class="text-sm text-text-secondary truncate">
						{{ req.name ? req.email : '' }}<span v-if="req.note"> — “{{ req.note }}”</span>
					</p>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<div class="flex flex-col items-end gap-1">
						<UiButton
							variant="primary"
							size="sm"
							:loading="busy?.id === req.id && busy?.action === 'provision'"
							:disabled="!hostedConfigured || (busy !== null && busy.id !== req.id)"
							@click="provision(req.id)"
						>
							Provision now
						</UiButton>
						<p v-if="!hostedConfigured" class="text-xs text-text-tertiary">
							Verify a sending domain first
						</p>
					</div>
					<UiButton
						variant="ghost"
						size="sm"
						:loading="busy?.id === req.id && busy?.action === 'resolve'"
						:disabled="busy !== null && busy.id !== req.id"
						@click="resolve(req.id)"
					>
						Mark done
					</UiButton>
				</div>
			</li>
		</ul>
	</div>
</template>
