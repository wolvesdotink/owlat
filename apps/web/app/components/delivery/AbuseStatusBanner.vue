<script setup lang="ts">
/**
 * The account-status banner at the top of the delivery hub: what the abuse
 * status means for sending, the reason stored with it and since when, and for
 * a platform admin the way to the operator console. Renders nothing while the
 * status is clean or unknown.
 */
import { api } from '@owlat/api';
import { formatDate } from '~/utils/formatters';
import { ArrowRightIcon, CircleWarningIcon, TriangleWarningIcon } from '@coolicons/vue';

const props = defineProps<{
	status: string | null | undefined;
	reason: string | null | undefined;
	changedAt: number | null | undefined;
}>();

const { t, locale } = useI18n();

// The stored reason is an English sentence written by the backend (it names
// the evidence), so it is quoted under translated framing, not translated.
const abuseWarning = computed(() => {
	const status = props.status;
	if (!status || status === 'clean') return null;
	const detail = {
		reason: props.reason ?? null,
		since: props.changedAt != null ? formatDate(props.changedAt, 'medium', locale.value) : null,
	};
	switch (status) {
		case 'warned':
			return {
				message: t('dashboard.admin.delivery.index.abuse.warned'),
				severity: 'warning' as const,
				...detail,
			};
		case 'suspended':
			return {
				message: t('dashboard.admin.delivery.index.abuse.suspended'),
				severity: 'error' as const,
				...detail,
			};
		case 'banned':
			return {
				message: t('dashboard.admin.delivery.index.abuse.banned'),
				severity: 'error' as const,
				...detail,
			};
		default:
			return null;
	}
});

// Only a platform admin can lift a suspension (operator console), so only
// they get the link; everyone else is told who can.
const isSendingBlocked = computed(() => abuseWarning.value?.severity === 'error');
const { data: isPlatformAdmin } = useConvexQuery(
	api.platformAdmin.platformAdmin.isPlatformAdmin,
	() => (isSendingBlocked.value ? {} : 'skip')
);
</script>

<template>
	<div
		v-if="abuseWarning"
		:class="
			abuseWarning.severity === 'error'
				? 'bg-error/10 border-error/20 text-error'
				: 'bg-warning/10 border-warning/20 text-warning'
		"
		class="mb-6 flex items-start gap-3 p-4 rounded-lg border"
	>
		<component
			:is="abuseWarning.severity === 'error' ? TriangleWarningIcon : CircleWarningIcon"
			class="w-5 h-5 mt-0.5 shrink-0"
		/>
		<div class="min-w-0 space-y-2 text-sm">
			<p>{{ abuseWarning.message }}</p>
			<div v-if="abuseWarning.reason" class="text-text-secondary">
				<p class="text-caption">{{ t('dashboard.admin.delivery.index.abuse.reason') }}</p>
				<blockquote class="mt-1 border-l-2 border-current pl-3 break-words">
					{{ abuseWarning.reason }}
				</blockquote>
			</div>
			<p v-if="abuseWarning.since" class="text-caption text-text-secondary">
				{{ t('dashboard.admin.delivery.index.abuse.since', { date: abuseWarning.since }) }}
			</p>
			<template v-if="isSendingBlocked">
				<NuxtLink
					v-if="isPlatformAdmin === true"
					to="/dashboard/admin/operator"
					class="inline-flex items-center gap-1 font-medium underline underline-offset-2"
				>
					{{ t('dashboard.admin.delivery.index.abuse.liftAction') }}
					<ArrowRightIcon class="w-4 h-4" aria-hidden="true" />
				</NuxtLink>
				<p v-else-if="isPlatformAdmin === false" class="text-text-secondary">
					{{ t('dashboard.admin.delivery.index.abuse.askOperator') }}
				</p>
			</template>
		</div>
	</div>
</template>
