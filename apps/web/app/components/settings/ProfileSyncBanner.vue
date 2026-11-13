<script setup lang="ts">
/**
 * Persistent "Services out of sync — Apply & restart" banner.
 * Rendered wherever a toggle can change the derived docker-profile set (the
 * admin features page, the migration-mode card). Names the affected services,
 * offers an Apply button with per-service results, and falls back to the host
 * CLI instructions when the updater sidecar is unreachable.
 */
import { useProfileSync, type ProfileServiceResult } from '~/composables/useProfileSync';
import { CircleCheckIcon, ReloadIcon } from '@coolicons/vue';

const props = defineProps<{
	/** Resolved flag snapshot to send to the updater on Apply. */
	flags: Record<string, boolean>;
}>();

const {
	pendingServices,
	isApplying,
	serviceResults,
	applyError,
	applyBusy,
	apply,
	dismissResults,
	hydrateFromProbe,
} = useProfileSync();

const { t } = useI18n();

// Both admin surfaces mount this component unconditionally, so this is the
// single place the durable drift probe needs to run (it de-duplicates itself,
// so mounting both surfaces still issues one request per page load).
onMounted(hydrateFromProbe);

// Compose reports its own state words (`running`, `healthy`, …). The ones it
// documents read as an outcome in the operator's language; anything else is
// shown as the daemon spells it, and "we were told nothing" is our copy.
const KNOWN_STATES = [
	'healthy',
	'unhealthy',
	'starting',
	'running',
	'restarting',
	'exited',
	'created',
	'paused',
	'dead',
] as const;
type KnownState = (typeof KNOWN_STATES)[number];
const isKnownState = (value: string): value is KnownState =>
	(KNOWN_STATES as readonly string[]).includes(value);

function serviceStateLabel(result: ProfileServiceResult): string {
	const raw = result.health || result.state || result.status;
	if (!raw) return t('common.unknown');
	const normalized = raw.toLowerCase();
	return isKnownState(normalized)
		? t(`components.settings.profileSyncBanner.states.${normalized}`)
		: raw;
}
</script>

<template>
	<div
		v-if="pendingServices.length > 0"
		data-testid="profile-sync-banner"
		class="rounded-xl border border-warning/40 bg-warning/5 px-5 py-4"
	>
		<div class="flex items-start gap-3">
			<ReloadIcon class="w-4 h-4 mt-1 text-warning shrink-0" />
			<div class="min-w-0 flex-1">
				<p class="font-medium text-text-primary">
					{{ t('components.settings.profileSyncBanner.title') }}
				</p>
				<I18nT
					keypath="components.settings.profileSyncBanner.pendingBody"
					tag="p"
					scope="global"
					class="mt-0.5 text-sm text-text-secondary"
				>
					<template #services>
						<span data-testid="profile-sync-services" class="font-mono">{{
							pendingServices.join(', ')
						}}</span>
					</template>
				</I18nT>
				<p
					v-if="applyBusy"
					data-testid="profile-sync-busy"
					role="status"
					class="mt-3 rounded-lg bg-bg-surface px-3 py-2.5 text-sm text-text-secondary"
				>
					{{ t('components.settings.profileSyncBanner.busy') }}
				</p>
				<div
					v-else-if="applyError"
					data-testid="profile-sync-fallback"
					class="mt-3 rounded-lg bg-bg-surface px-3 py-2.5 text-sm text-text-secondary"
				>
					<p>
						{{
							t('components.settings.profileSyncBanner.updaterUnreachable', {
								error: applyError,
							})
						}}
					</p>
					<I18nT
						keypath="components.settings.profileSyncBanner.fallback"
						tag="p"
						scope="global"
						class="mt-1.5"
					>
						<template #featureCommand>
							<code class="bg-bg-base px-1.5 py-0.5 rounded"
								>owlat feature &lt;flag&gt; on&nbsp;|&nbsp;off</code
							>
						</template>
						<template #applyCommand>
							<code class="bg-bg-base px-1.5 py-0.5 rounded">owlat apply</code>
						</template>
					</I18nT>
				</div>
			</div>
			<UiButton data-testid="profile-sync-apply" :loading="isApplying" @click="apply(props.flags)">
				{{
					isApplying
						? t('components.settings.profileSyncBanner.applying')
						: t('components.settings.profileSyncBanner.apply')
				}}
			</UiButton>
		</div>
	</div>

	<div
		v-else-if="serviceResults"
		data-testid="profile-sync-results"
		class="rounded-xl border border-border-subtle bg-bg-surface px-5 py-4"
	>
		<div class="flex items-start gap-3">
			<CircleCheckIcon class="w-4 h-4 mt-1 text-success shrink-0" />
			<div class="min-w-0 flex-1">
				<p class="font-medium text-text-primary">
					{{ t('components.settings.profileSyncBanner.appliedTitle') }}
				</p>
				<ul v-if="serviceResults.length > 0" class="mt-2 space-y-1">
					<li
						v-for="result in serviceResults"
						:key="result.service ?? 'unknown'"
						:data-testid="`profile-sync-service-${result.service}`"
						class="text-sm text-text-secondary flex items-center gap-2"
					>
						<code class="text-xs bg-bg-base px-1.5 py-0.5 rounded">{{ result.service }}</code>
						<span>{{ serviceStateLabel(result) }}</span>
					</li>
				</ul>
				<p v-else class="mt-1 text-sm text-text-secondary">
					{{ t('components.settings.profileSyncBanner.convergedBody') }}
				</p>
			</div>
			<UiButton
				variant="ghost"
				size="sm"
				data-testid="profile-sync-dismiss"
				@click="dismissResults"
			>
				{{ t('common.dismiss') }}
			</UiButton>
		</div>
	</div>
</template>
