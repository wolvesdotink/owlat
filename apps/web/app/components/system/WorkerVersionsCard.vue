<script setup lang="ts">
/**
 * Worker versions (Settings → System & updates): per worker service (IMAP
 * server, mail-sync, MTA, code-worker), the releases that reported to this
 * backend in the last 7 days, their wire versions, and whether the backend
 * still serves each one's contract. An operator checks it after an update, to
 * see that every worker container followed the backend; the migration runner
 * holds a contract step on the same reports.
 */
import { api } from '@owlat/api';
import { formatDateTime } from '~/utils/formatters';
import type { WorkerService } from '@owlat/shared/workerWire';
import { workerServiceKey } from '~/utils/workerServices';

const { t } = useI18n();

const {
	data: status,
	error,
	refetch,
} = useConvexQuery(api.maintenance.workerRegistry.getForAdmin, () => ({}));

type Verdict = 'current' | 'supported' | 'unsupported' | 'ahead';

const services = computed(() => status.value?.services ?? []);
type ServiceStatus = (typeof services.value)[number];

function serviceName(service: WorkerService): string {
	return t(`components.system.workerVersionsCard.services.${workerServiceKey(service)}`);
}

// From the summary, which covers every worker of the service in the window
// (an IMAP legacy login counting as wire 0); the list is capped.
function hasUnsupported(entry: ServiceStatus): boolean {
	const oldest = entry.oldestWireVersionSeen;
	return oldest !== null && oldest < entry.minSupportedWireVersion;
}
function hasAhead(entry: ServiceStatus): boolean {
	const newest = entry.newestWireVersionSeen;
	return newest !== null && newest > entry.backendWireVersion;
}
/** More than one wire version of the service reported in the window. */
function hasSkew(entry: ServiceStatus): boolean {
	return (
		entry.oldestWireVersionSeen !== null &&
		entry.newestWireVersionSeen !== null &&
		entry.oldestWireVersionSeen !== entry.newestWireVersionSeen
	);
}

const VERDICT_CLASS: Record<Verdict, { pill: string; dot: string }> = {
	current: { pill: 'bg-success/10 text-success', dot: 'bg-success' },
	supported: { pill: 'bg-bg-surface text-text-secondary', dot: 'bg-text-tertiary' },
	unsupported: { pill: 'bg-error/10 text-error', dot: 'bg-error' },
	ahead: { pill: 'bg-warning/10 text-warning', dot: 'bg-warning' },
};
</script>

<template>
	<div class="card">
		<h3 class="font-semibold text-text-primary mb-1">
			{{ t('components.system.workerVersionsCard.title') }}
		</h3>
		<p class="text-caption text-text-tertiary mb-4">
			{{ t('components.system.workerVersionsCard.intro') }}
		</p>

		<!-- A failed read is not "nothing reported": show the error. -->
		<UiQueryBoundary v-if="error" :error="error" @retry="refetch" />

		<div v-else-if="!status" class="text-caption text-text-tertiary">
			{{ t('components.system.workerVersionsCard.loading') }}
		</div>

		<div v-else class="space-y-6">
			<section
				v-for="entry in services"
				:key="entry.service"
				:data-test="`worker-service-${entry.service}`"
			>
				<div class="flex items-baseline justify-between gap-3 flex-wrap mb-2">
					<h4 class="text-sm font-medium text-text-primary">{{ serviceName(entry.service) }}</h4>
					<p class="text-caption text-text-tertiary">
						{{
							entry.minSupportedWireVersion < entry.backendWireVersion
								? t('components.system.workerVersionsCard.contract', {
										current: entry.backendWireVersion,
										min: entry.minSupportedWireVersion,
									})
								: t('components.system.workerVersionsCard.contractSingle', {
										current: entry.backendWireVersion,
									})
						}}
					</p>
				</div>

				<div
					v-if="
						entry.isLegacyInWindow || hasUnsupported(entry) || hasAhead(entry) || hasSkew(entry)
					"
					class="mb-3 space-y-2"
					role="status"
				>
					<p
						v-if="entry.isLegacyInWindow"
						class="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-caption text-text-primary"
					>
						<Icon
							name="lucide:alert-triangle"
							class="w-4 h-4 text-warning shrink-0 mt-0.5"
							aria-hidden="true"
						/>
						{{
							t('components.system.workerVersionsCard.legacyImapWarning', {
								date: formatDateTime(entry.legacySeenAt),
							})
						}}
					</p>
					<p
						v-if="hasUnsupported(entry)"
						class="flex items-start gap-2 rounded-lg border border-error/40 bg-error/5 p-3 text-caption text-text-primary"
					>
						<Icon
							name="lucide:x-circle"
							class="w-4 h-4 text-error shrink-0 mt-0.5"
							aria-hidden="true"
						/>
						{{ t('components.system.workerVersionsCard.unsupportedWarning') }}
					</p>
					<p
						v-if="hasAhead(entry)"
						class="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-caption text-text-primary"
					>
						<Icon
							name="lucide:alert-triangle"
							class="w-4 h-4 text-warning shrink-0 mt-0.5"
							aria-hidden="true"
						/>
						{{ t('components.system.workerVersionsCard.aheadWarning') }}
					</p>
					<p v-if="hasSkew(entry)" class="text-caption text-text-secondary" data-test="skew">
						{{
							t('components.system.workerVersionsCard.skew', {
								oldest: entry.oldestWireVersionSeen,
								newest: entry.newestWireVersionSeen,
							})
						}}
					</p>
				</div>

				<!-- Nothing reported: the service does not run here, or none started
				     this week. Named, so it does not read as a broken card. -->
				<p v-if="entry.servers.length === 0" class="text-caption text-text-tertiary">
					{{ t('components.system.workerVersionsCard.empty') }}
				</p>

				<!-- Scroll container, as on the other tables of this page: the
				     columns do not fit a phone. -->
				<div v-else class="-mx-6 px-6 overflow-x-auto">
					<table class="w-full min-w-max text-caption">
						<thead>
							<tr class="border-b border-border-subtle text-text-tertiary">
								<th class="text-left py-2 font-medium">
									{{ t('components.system.workerVersionsCard.host') }}
								</th>
								<th class="text-left py-2 font-medium">
									{{ t('components.system.workerVersionsCard.version') }}
								</th>
								<th class="text-left py-2 font-medium">
									{{ t('components.system.workerVersionsCard.lastSeen') }}
								</th>
								<th class="text-left py-2 font-medium">{{ t('common.status') }}</th>
							</tr>
						</thead>
						<tbody>
							<tr
								v-for="server in entry.servers"
								:key="`${server.hostLabel}:${server.owlatVersion}:${server.wireVersion}`"
								class="border-b border-border-subtle last:border-b-0"
							>
								<td class="py-2 pr-4 font-mono text-text-primary">{{ server.hostLabel }}</td>
								<td class="py-2 pr-4 text-text-secondary">
									<span class="font-mono text-text-primary">{{ server.owlatVersion }}</span>
									{{
										t('components.system.workerVersionsCard.wireVersion', {
											version: server.wireVersion,
										})
									}}
								</td>
								<td class="py-2 pr-4 text-text-secondary">
									{{ formatDateTime(server.lastSeenAt) }}
									<span v-if="!server.isLive" class="text-text-tertiary">
										· {{ t('components.system.workerVersionsCard.notLive') }}
									</span>
								</td>
								<td class="py-2">
									<span
										class="inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full"
										:class="VERDICT_CLASS[server.verdict].pill"
									>
										<span
											class="w-1.5 h-1.5 rounded-full"
											:class="VERDICT_CLASS[server.verdict].dot"
										/>
										{{ t(`components.system.workerVersionsCard.verdict.${server.verdict}`) }}
									</span>
								</td>
							</tr>
						</tbody>
					</table>
					<p v-if="entry.isListTruncated" class="mt-2 text-caption text-text-tertiary">
						{{
							t('components.system.workerVersionsCard.truncated', {
								count: entry.servers.length,
							})
						}}
					</p>
				</div>
			</section>
		</div>
	</div>
</template>
