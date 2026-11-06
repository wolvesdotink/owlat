<script setup lang="ts">
/**
 * Settings → AI: the provider is refusing the instance's language key. Every
 * AI feature depends on it, so it is said here (and once in the app shell)
 * instead of on every thread. Nothing shows while the key is accepted; the
 * record clears when a call goes through again or the settings are saved.
 */
import { api } from '@owlat/api';
import { TriangleWarningIcon } from '@coolicons/vue';
import { formatDateTime } from '~/utils/formatters';

const { t } = useI18n();
const { data: failure } = useOrganizationQuery(api.aiRouting.providerHealth.getAuthFailure);
</script>

<template>
	<div
		v-if="failure"
		role="status"
		class="flex items-start gap-3 rounded-lg bg-warning-subtle/50 border border-border-subtle p-4 text-sm"
		data-testid="ai-provider-key-refused"
	>
		<TriangleWarningIcon class="w-5 h-5 text-warning shrink-0 mt-0.5" />
		<div>
			<p class="text-text-primary font-medium">
				{{ t('dashboard.admin.instance.aiProvider.keyRefused.title') }}
			</p>
			<p class="text-text-secondary mt-0.5">
				{{
					t('dashboard.admin.instance.aiProvider.keyRefused.body', {
						since: formatDateTime(failure.firstSeenAt),
					})
				}}
			</p>
			<p class="text-text-tertiary text-xs mt-1">
				{{
					t('dashboard.admin.instance.aiProvider.keyRefused.lastSeen', {
						time: formatDateTime(failure.lastSeenAt),
					})
				}}
			</p>
		</div>
	</div>
</template>
