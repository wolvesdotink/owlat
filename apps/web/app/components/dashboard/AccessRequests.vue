<script setup lang="ts">
/**
 * Admin surfacing point for access requests (piece b5).
 *
 * A signed-in user who belongs to no organization hits the invite-only wall on
 * /setup/team and asks for access via `auth.accessRequest.request`. Those open
 * requests land here on the dashboard — where every admin already looks — so the
 * ask isn't lost. Resolving a row is a plain acknowledgement: the admin invites
 * the person through the normal members flow, then marks the request done.
 * Requesting NEVER grants membership on its own.
 *
 * Only rendered for admins by the parent; the backend also gates every read and
 * write on the admin role, so this is defence-in-depth, not the fence.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { data: requests, isLoading } = useConvexQuery(
	api.auth.accessRequest.listPending,
	() => ({})
);

const { t } = useI18n();

const { run: resolveRequest } = useBackendOperation(api.auth.accessRequest.resolve, {
	label: () => t('components.dashboard.accessRequests.resolveOperation'),
});

const openRequests = computed(() => requests.value ?? []);

// Which row is mid-resolve, so only that button spins (not every row's).
const resolvingId = ref<Id<'accessRequests'> | null>(null);

async function resolve(requestId: Id<'accessRequests'>) {
	if (resolvingId.value) return;
	resolvingId.value = requestId;
	try {
		await resolveRequest({ requestId });
	} finally {
		resolvingId.value = null;
	}
}
</script>

<template>
	<div v-if="!isLoading && openRequests.length" class="card mb-8">
		<div class="flex items-center gap-3 mb-4">
			<UiIconBox icon="lucide:user-plus" variant="surface" />
			<div>
				<h2 class="text-lg font-semibold text-text-primary">
					{{ t('components.dashboard.accessRequests.title') }}
				</h2>
				<p class="text-sm text-text-secondary mt-0.5">
					{{ t('components.dashboard.accessRequests.subtitle', openRequests.length) }}
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
				<UiButton
					variant="outline"
					size="sm"
					:loading="resolvingId === req.id"
					:disabled="resolvingId !== null && resolvingId !== req.id"
					@click="resolve(req.id)"
				>
					{{ t('components.dashboard.accessRequests.markDone') }}
				</UiButton>
			</li>
		</ul>
	</div>
</template>
