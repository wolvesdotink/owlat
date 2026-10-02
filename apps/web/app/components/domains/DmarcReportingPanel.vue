<script setup lang="ts">
/**
 * DMARC aggregate reports for one sending domain, under its DMARC record.
 *
 * Says where receivers send the domain's daily reports and whether the
 * published record asks for them yet. When Owlat reads reports itself it adds
 * the one-click record update (same policy, `rua=` added — the operator still
 * publishes it), the RFC 7489 §7.1 authorization record when the report address
 * sits outside the domain's organizational domain, and a link to the dashboard.
 * When it cannot, it explains why and what the fallback (`MTA_DMARC_RUA`) does.
 *
 * Admin-only, like the query behind it: a member who cannot manage domains
 * never subscribes and sees nothing.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { DmarcPolicy } from '~/utils/domainStatus';
import { formatRelativeTime } from '~/utils/formatters';

const props = withDefaults(
	defineProps<{
		domainId: Id<'domains'>;
		domain: string;
		dmarcPolicy: DmarcPolicy | undefined;
		dmarcSubdomainPolicy: DmarcPolicy | undefined;
		dmarcPct: number | undefined;
		canManage: boolean;
		/** Off on the dashboard itself, where "Open reports" would link to the same page. */
		showReportsLink?: boolean;
	}>(),
	{ showReportsLink: true }
);

const { t } = useI18n();
const { showToast } = useToast();

const {
	data: setup,
	isLoading,
	error,
} = useConvexQuery(api.domains.dmarcReports.getDomainReporting, () =>
	props.canManage ? { domainId: props.domainId } : 'skip'
);

// Same policy, same knobs: the lifecycle regenerates the record with the
// current `rua=` and drops the stale DMARC verification so it gets re-checked.
const { run: setDmarcPolicy, isLoading: isUpdating } = useBackendOperation(
	api.domains.domains.setDmarcPolicy,
	{ label: () => t('components.domains.dmarcReporting.operations.update') }
);

async function requestReports() {
	const result = await setDmarcPolicy({
		domainId: props.domainId,
		policy: props.dmarcPolicy ?? 'none',
		subdomainPolicy: props.dmarcSubdomainPolicy,
		pct: props.dmarcPct,
	});
	if (result.ok) showToast(t('components.domains.dmarcReporting.toasts.updated'));
}

const needsRecordUpdate = computed(
	() => setup.value?.mode === 'owlat' && !setup.value.isRecordRequestingReports
);
const reportsLink = computed(
	() => `/dashboard/admin/delivery/dmarc?domain=${encodeURIComponent(props.domain)}`
);
const reportDomain = computed(() => {
	const address = setup.value?.reportAddress ?? '';
	return address.slice(address.lastIndexOf('@') + 1);
});
</script>

<template>
	<div
		v-if="canManage && (isLoading || error || setup?.hasDmarcRecord)"
		class="mt-3 rounded-xl border border-border-subtle bg-bg-surface p-4"
		data-testid="dmarc-reporting-panel"
	>
		<div class="flex items-start justify-between gap-3">
			<div class="min-w-0">
				<p class="text-xs font-medium uppercase tracking-wider text-text-tertiary">
					{{ t('components.domains.dmarcReporting.title') }}
				</p>
			</div>
			<NuxtLink
				v-if="setup?.mode === 'owlat' && showReportsLink"
				:to="reportsLink"
				class="inline-flex shrink-0 items-center gap-1 text-sm text-brand hover:underline"
				data-testid="dmarc-reports-link"
			>
				{{ t('components.domains.dmarcReporting.openReports') }}
				<Icon name="lucide:arrow-right" class="h-3.5 w-3.5" />
			</NuxtLink>
		</div>

		<p v-if="isLoading && !setup" class="mt-2 text-sm text-text-tertiary">
			{{ t('components.domains.dmarcReporting.loading') }}
		</p>
		<p v-else-if="error" class="mt-2 flex items-start gap-2 text-sm text-text-secondary">
			<Icon name="lucide:alert-circle" class="mt-0.5 h-4 w-4 shrink-0 text-warning" />
			{{ t('components.domains.dmarcReporting.error') }}
		</p>

		<template v-else-if="setup">
			<!-- Owlat reads the reports. -->
			<div v-if="setup.mode === 'owlat'" class="mt-2 space-y-3">
				<I18nT
					keypath="components.domains.dmarcReporting.owlat.body"
					tag="p"
					scope="global"
					class="text-sm text-text-secondary"
				>
					<template #address>
						<code class="text-text-primary">{{ setup.reportAddress }}</code>
					</template>
				</I18nT>

				<div
					v-if="needsRecordUpdate"
					class="flex flex-col gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3 sm:flex-row sm:items-center sm:justify-between"
					data-testid="dmarc-record-update"
				>
					<p class="text-sm text-text-secondary">
						{{ t('components.domains.dmarcReporting.owlat.notRequested') }}
					</p>
					<UiButton
						size="sm"
						variant="secondary"
						class="shrink-0 gap-1.5"
						:disabled="isUpdating"
						@click="requestReports"
					>
						<Icon
							:name="isUpdating ? 'lucide:loader-2' : 'lucide:file-plus'"
							:class="['h-4 w-4', isUpdating && 'animate-spin motion-reduce:animate-none']"
						/>
						{{ t('components.domains.dmarcReporting.owlat.update') }}
					</UiButton>
				</div>
				<p v-else class="text-sm text-text-secondary" data-testid="dmarc-last-report">
					{{
						setup.lastReportAt
							? t('components.domains.dmarcReporting.owlat.lastReport', {
									when: formatRelativeTime(setup.lastReportAt),
								})
							: t('components.domains.dmarcReporting.owlat.noReportsYet')
					}}
				</p>

				<!-- RFC 7489 §7.1: the report domain must agree to receive them. -->
				<div v-if="setup.authorizationRecord" class="space-y-2" data-testid="dmarc-authorization">
					<p class="text-sm text-text-secondary">
						{{
							t('components.domains.dmarcReporting.owlat.authorization', {
								reportDomain,
							})
						}}
					</p>
					<DomainsDNSRecordPanel
						:record="{
							type: setup.authorizationRecord.type,
							host: setup.authorizationRecord.hostname,
							hostIsFqdn: true,
							value: setup.authorizationRecord.value,
						}"
						:label="t('components.domains.dmarcReporting.owlat.authorizationLabel')"
						:domain="reportDomain"
					/>
				</div>
			</div>

			<!-- Reports go to an address configured outside Owlat. -->
			<I18nT
				v-else-if="setup.mode === 'external'"
				keypath="components.domains.dmarcReporting.external"
				tag="p"
				scope="global"
				class="mt-2 text-sm text-text-secondary"
			>
				<template #rua>
					<code class="break-all text-text-primary">{{ setup.externalRua }}</code>
				</template>
				<template #variable><code class="text-text-primary">RETURN_PATH_DOMAIN</code></template>
			</I18nT>

			<!-- No reporting address at all. -->
			<I18nT
				v-else
				keypath="components.domains.dmarcReporting.none"
				tag="p"
				scope="global"
				class="mt-2 text-sm text-text-secondary"
			>
				<template #variable><code class="text-text-primary">RETURN_PATH_DOMAIN</code></template>
				<template #fallback><code class="text-text-primary">MTA_DMARC_RUA</code></template>
			</I18nT>
		</template>
	</div>
</template>
