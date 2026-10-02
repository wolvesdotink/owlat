<script setup lang="ts">
/**
 * IMAP servers (Settings → System & updates): the IMAP server releases that
 * reported to this backend in the last 7 days, and whether the backend still
 * serves their wire contract (ADR-0063). An operator checks it after an
 * update, to see that the IMAP container followed the backend.
 */
import { api } from '@owlat/api';
import { formatDateTime } from '~/utils/formatters';

const { t } = useI18n();

const {
	data: status,
	error,
	refetch,
} = useConvexQuery(api.mail.imap.serverRegistry.getForAdmin, () => ({}));

type Verdict = 'current' | 'supported' | 'unsupported' | 'ahead';

const servers = computed(() => status.value?.servers ?? []);
const isLegacyInWindow = computed(() => status.value?.isLegacyInWindow === true);
// From the summary, which covers every server in the window (a legacy login
// counting as wire 0); the list is capped.
const hasUnsupported = computed(() => {
	const oldest = status.value?.oldestWireVersionSeen;
	if (oldest === null || oldest === undefined) return false;
	return oldest < status.value!.minSupportedWireVersion;
});
const hasAhead = computed(() => {
	const newest = status.value?.newestWireVersionSeen;
	if (newest === null || newest === undefined) return false;
	return newest > status.value!.backendWireVersion;
});

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
			{{ t('components.system.imapServersCard.title') }}
		</h3>
		<p class="text-caption text-text-tertiary mb-4">
			{{ t('components.system.imapServersCard.intro') }}
		</p>

		<!-- A failed read is not "nothing reported": show the error. -->
		<UiQueryBoundary v-if="error" :error="error" @retry="refetch" />

		<div v-else-if="!status" class="text-caption text-text-tertiary">
			{{ t('components.system.imapServersCard.loading') }}
		</div>

		<template v-else>
			<div
				v-if="isLegacyInWindow || hasUnsupported || hasAhead"
				class="mb-4 space-y-2"
				role="status"
			>
				<p
					v-if="isLegacyInWindow"
					class="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-caption text-text-primary"
				>
					<Icon
						name="lucide:alert-triangle"
						class="w-4 h-4 text-warning shrink-0 mt-0.5"
						aria-hidden="true"
					/>
					{{
						t('components.system.imapServersCard.legacyWarning', {
							date: formatDateTime(status.legacyImapSeenAt),
						})
					}}
				</p>
				<p
					v-if="hasUnsupported"
					class="flex items-start gap-2 rounded-lg border border-error/40 bg-error/5 p-3 text-caption text-text-primary"
				>
					<Icon
						name="lucide:x-circle"
						class="w-4 h-4 text-error shrink-0 mt-0.5"
						aria-hidden="true"
					/>
					{{ t('components.system.imapServersCard.unsupportedWarning') }}
				</p>
				<p
					v-if="hasAhead"
					class="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-caption text-text-primary"
				>
					<Icon
						name="lucide:alert-triangle"
						class="w-4 h-4 text-warning shrink-0 mt-0.5"
						aria-hidden="true"
					/>
					{{ t('components.system.imapServersCard.aheadWarning') }}
				</p>
			</div>

			<!-- Nothing reported: no IMAP container runs, or none started this
			     week. Named, so it does not read as a broken card. -->
			<div v-if="servers.length === 0" class="text-caption text-text-tertiary">
				{{ t('components.system.imapServersCard.empty') }}
			</div>

			<!-- Scroll container, as on the other tables of this page: the
			     columns do not fit a phone. -->
			<div v-else class="-mx-6 px-6 overflow-x-auto">
				<table class="w-full min-w-max text-caption">
					<thead>
						<tr class="border-b border-border-subtle text-text-tertiary">
							<th class="text-left py-2 font-medium">
								{{ t('components.system.imapServersCard.host') }}
							</th>
							<th class="text-left py-2 font-medium">
								{{ t('components.system.imapServersCard.version') }}
							</th>
							<th class="text-left py-2 font-medium">
								{{ t('components.system.imapServersCard.lastSeen') }}
							</th>
							<th class="text-left py-2 font-medium">{{ t('common.status') }}</th>
						</tr>
					</thead>
					<tbody>
						<tr
							v-for="server in servers"
							:key="`${server.hostLabel}:${server.owlatVersion}:${server.wireVersion}`"
							class="border-b border-border-subtle last:border-b-0"
						>
							<td class="py-2 pr-4 font-mono text-text-primary">{{ server.hostLabel }}</td>
							<td class="py-2 pr-4 text-text-secondary">
								<span class="font-mono text-text-primary">{{ server.owlatVersion }}</span>
								{{
									t('components.system.imapServersCard.wireVersion', {
										version: server.wireVersion,
									})
								}}
							</td>
							<td class="py-2 pr-4 text-text-secondary">
								{{ formatDateTime(server.lastSeenAt) }}
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
									{{ t(`components.system.imapServersCard.verdict.${server.verdict}`) }}
								</span>
							</td>
						</tr>
					</tbody>
				</table>
				<p v-if="status.isListTruncated" class="mt-2 text-caption text-text-tertiary">
					{{ t('components.system.imapServersCard.truncated', { count: servers.length }) }}
				</p>
			</div>
		</template>
	</div>
</template>
