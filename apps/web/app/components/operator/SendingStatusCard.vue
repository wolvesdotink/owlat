<script setup lang="ts">
import { abuseStatusVariant, isBlockingAbuseStatus } from '~/utils/operatorConsole';

type AbuseStatus = 'clean' | 'warned' | 'suspended' | 'banned';

defineProps<{
	currentAbuseStatus: string;
	abuseStatusReason: string | undefined;
	/** The soft auto-warn state: flagged, but sending still allowed. */
	isWarned: boolean;
	/** Any console write is in flight; every action waits for it. */
	busy: boolean;
}>();

const emit = defineEmits<{ setStatus: [initial: AbuseStatus] }>();

const { t, te } = useI18n();

/** The status's words, or the raw value when it has no copy of its own. */
function statusLabel(value: string): string {
	const key = `dashboard.admin.operator.index.abuseStatus.${value}`;
	return te(key) ? t(key) : value;
}
</script>

<template>
	<div class="card">
		<div class="flex items-start justify-between gap-4 flex-wrap">
			<div>
				<h3 class="text-sm font-medium text-text-tertiary uppercase tracking-wider mb-2">
					{{ t('dashboard.admin.operator.index.sending.title') }}
				</h3>
				<div class="flex items-center gap-2">
					<UiBadge :variant="abuseStatusVariant(currentAbuseStatus)" size="md">{{
						statusLabel(currentAbuseStatus)
					}}</UiBadge>
					<span v-if="isBlockingAbuseStatus(currentAbuseStatus)" class="text-caption text-error">
						{{ t('dashboard.admin.operator.index.sending.blocked') }}
					</span>
					<span v-else-if="isWarned" class="text-caption text-warning">
						{{ t('dashboard.admin.operator.index.sending.warned') }}
					</span>
				</div>
				<p v-if="abuseStatusReason" class="mt-2 text-caption text-text-secondary">
					{{
						t('dashboard.admin.operator.index.sending.reason', {
							reason: abuseStatusReason,
						})
					}}
				</p>
			</div>
			<div class="flex gap-2">
				<UiButton
					v-if="isBlockingAbuseStatus(currentAbuseStatus)"
					variant="primary"
					size="sm"
					:disabled="busy"
					@click="emit('setStatus', 'clean')"
				>
					{{ t('dashboard.admin.operator.index.sending.unsuspend') }}
				</UiButton>
				<UiButton
					v-else
					variant="danger-outline"
					size="sm"
					:disabled="busy"
					@click="emit('setStatus', 'suspended')"
				>
					{{ t('dashboard.admin.operator.index.sending.suspend') }}
				</UiButton>
			</div>
		</div>
	</div>
</template>
