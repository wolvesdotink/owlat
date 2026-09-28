<script setup lang="ts">
/**
 * Delivery provider → Blocklist lookups: how the MTA reaches Spamhaus, whether
 * the last sweep got an answer, and the optional Spamhaus Data Query Service key.
 *
 * Spamhaus only answers its public mirror for servers it can identify, so on
 * most shared resolvers and hosting networks every check comes back refused
 * and a new sending IP never leaves quarantine. The shipped compose runs a
 * resolver for these lookups; where that is not enough, a free DQS key is, and
 * this card is where it goes. The Outbound IPs card links here
 * (`#blocklist-lookups`) whenever a check could not be measured.
 *
 * The key is write-only: the MTA verifies and seals it, and only its last four
 * characters ever come back.
 */
import { api } from '@owlat/api';
import { formatCompactRelativeTime } from '~/utils/formatters';
import { healthChipClass } from '~/utils/healthTone';
import {
	blocklistFailureDetail,
	blocklistLookupsStatus,
	blocklistResolverLabel,
	keyRejectionMessage,
	type DnsblAccessView,
} from '~/utils/blocklistLookups';

const SPAMHAUS_DQS_SIGNUP_URL =
	'https://www.spamhaus.com/free-trial/sign-up-for-a-free-data-query-service-account/';
/** A new key or its removal re-runs the sweep; look again once it has had time to land. */
const PENDING_REFRESH_MS = 8_000;
const PENDING_REFRESH_LIMIT = 4;

const { t } = useI18n();
const { showToast } = useToast();
const route = useRoute();

const view = ref<DnsblAccessView | null>(null);
const key = ref('');
const keyError = ref<string | null>(null);

const { run: load } = useBackendOperation(api.delivery.dnsblAccess.get, {
	type: 'action',
	label: () => t('components.delivery.blocklistLookups.loadOperation'),
	announce: false,
});
const { run: saveKey, isLoading: saving } = useBackendOperation(
	api.delivery.dnsblAccess.setSpamhausKey,
	{ type: 'action', label: () => t('components.delivery.blocklistLookups.saveOperation') }
);

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshes = 0;
async function refresh() {
	const result = await load({});
	if (result.ok) view.value = result.result;
	scheduleRefreshWhilePending();
}
function scheduleRefreshWhilePending() {
	if (refreshTimer) clearTimeout(refreshTimer);
	refreshTimer = null;
	const pending = access.value?.spamhaus.status === 'pending';
	if (!pending || refreshes >= PENDING_REFRESH_LIMIT) return;
	refreshes += 1;
	refreshTimer = setTimeout(() => void refresh(), PENDING_REFRESH_MS);
}

onMounted(async () => {
	await refresh();
	// The Outbound IPs card links here by hash; the card only exists once the
	// page's query boundary has rendered, after the router's own scroll ran.
	if (route.hash === '#blocklist-lookups') {
		await nextTick();
		document.getElementById('blocklist-lookups')?.scrollIntoView({ block: 'start' });
	}
});
onBeforeUnmount(() => {
	if (refreshTimer) clearTimeout(refreshTimer);
});

const access = computed(() => (view.value?.status === 'ready' ? view.value.access : null));
const status = computed(() => blocklistLookupsStatus(view.value));
const failureDetail = computed(() =>
	access.value ? blocklistFailureDetail(access.value.spamhaus) : null
);
const lastChecked = computed(() => {
	const at = access.value?.spamhaus.checkedAt;
	return at ? formatCompactRelativeTime(at) : null;
});
const hasKey = computed(() => access.value?.spamhaus.access === 'dqs');

async function submit(value: string | null) {
	keyError.value = null;
	const result = await saveKey({ key: value });
	if (!result.ok) return;
	if (!result.result.ok) {
		keyError.value = t(keyRejectionMessage(result.result.reason));
		return;
	}
	view.value = { status: 'ready', access: result.result.access };
	key.value = '';
	refreshes = 0;
	scheduleRefreshWhilePending();
	showToast(
		t(
			value === null
				? 'components.delivery.blocklistLookups.removed'
				: 'components.delivery.blocklistLookups.saved'
		)
	);
}
</script>

<template>
	<UiCard
		id="blocklist-lookups"
		padding="none"
		overflow="hidden"
		class="scroll-mt-6"
		data-testid="blocklist-lookups"
	>
		<template #header>
			<div class="flex items-start justify-between gap-4">
				<div class="flex items-center gap-3">
					<UiIconBox icon="lucide:shield-check" size="sm" variant="surface" rounded="lg" />
					<div>
						<h2 class="text-lg font-semibold text-text-primary">
							{{ t('components.delivery.blocklistLookups.title') }}
						</h2>
						<p class="text-sm text-text-secondary">
							{{ t('components.delivery.blocklistLookups.subtitle') }}
						</p>
					</div>
				</div>
				<span
					class="px-2.5 py-1 rounded-full text-xs font-medium shrink-0"
					:class="healthChipClass[status.tone]"
					data-testid="blocklist-lookups-status"
				>
					{{ t(status.label) }}
				</span>
			</div>
		</template>

		<div class="p-6 space-y-5">
			<p v-if="view?.status === 'unavailable'" class="text-sm text-text-secondary">
				{{ t('components.delivery.blocklistLookups.unavailable') }}
			</p>

			<template v-if="access">
				<div class="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<p class="text-xs text-text-tertiary">
							{{ t('components.delivery.blocklistLookups.access.label') }}
						</p>
						<p class="text-text-primary mt-0.5" data-testid="blocklist-lookups-access">
							{{
								hasKey
									? t('components.delivery.blocklistLookups.access.dqs', {
											hint: access.spamhaus.keyHint ?? '',
										})
									: t('components.delivery.blocklistLookups.access.public')
							}}
						</p>
					</div>
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<p class="text-xs text-text-tertiary">
							{{ t('components.delivery.blocklistLookups.resolver.label') }}
						</p>
						<p class="text-text-primary mt-0.5">
							{{ t(blocklistResolverLabel(access.resolver)) }}
						</p>
					</div>
					<div class="rounded-lg bg-bg-surface px-3 py-2">
						<p class="text-xs text-text-tertiary">
							{{ t('components.delivery.blocklistLookups.lastCheck') }}
						</p>
						<p class="text-text-primary mt-0.5">
							{{ lastChecked ?? t('components.delivery.blocklistLookups.status.pending') }}
						</p>
					</div>
				</div>

				<div
					v-if="failureDetail"
					class="rounded-lg border border-error/20 bg-error/10 px-3 py-2.5 text-sm text-error"
					data-testid="blocklist-lookups-failure"
				>
					{{ t(failureDetail) }}
				</div>

				<form class="space-y-3" @submit.prevent="submit(key)">
					<UiInput
						v-model="key"
						type="password"
						autocomplete="off"
						:label="t('components.delivery.blocklistLookups.key.label')"
						:placeholder="
							hasKey
								? t('components.delivery.blocklistLookups.key.replacePlaceholder')
								: t('components.delivery.blocklistLookups.key.placeholder')
						"
						:error="keyError ?? undefined"
						:help-text="t('components.delivery.blocklistLookups.key.help')"
						data-testid="blocklist-lookups-key"
					/>
					<p class="text-xs text-text-tertiary">
						<a
							:href="SPAMHAUS_DQS_SIGNUP_URL"
							target="_blank"
							rel="noopener"
							class="inline-flex items-center gap-1 font-medium text-brand underline underline-offset-2"
						>
							{{ t('components.delivery.blocklistLookups.key.getKey') }}
							<Icon name="lucide:external-link" class="w-3 h-3" />
						</a>
						·
						{{ t('components.delivery.blocklistLookups.key.freeNote') }}
					</p>
					<div class="flex flex-wrap gap-2">
						<UiButton type="submit" :loading="saving" :disabled="key.trim().length === 0">
							{{ t('components.delivery.blocklistLookups.key.save') }}
						</UiButton>
						<UiButton
							v-if="hasKey"
							variant="ghost"
							:disabled="saving"
							data-testid="blocklist-lookups-remove"
							@click="submit(null)"
						>
							{{ t('components.delivery.blocklistLookups.key.remove') }}
						</UiButton>
					</div>
				</form>
			</template>
		</div>
	</UiCard>
</template>
