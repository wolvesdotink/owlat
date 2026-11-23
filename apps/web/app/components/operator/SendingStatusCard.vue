<script setup lang="ts">
/**
 * The instance's sending status in the operator console: the status, how a
 * suspension lifts (or what a lift paused), the button that lifts or imposes
 * one, and the switch that makes every suspension wait for a platform admin.
 */
import { api } from '@owlat/api';
import { resolveLocalized } from '~/utils/localizedText';
import { abuseStatusVariant, isBlockingAbuseStatus } from '~/utils/operatorConsole';
import {
	reputationHoldText,
	suspensionLiftText,
	type SendingStatusView,
} from '~/utils/suspensionLift';

type AbuseStatus = 'clean' | 'warned' | 'suspended' | 'banned';

const props = defineProps<{
	currentAbuseStatus: string;
	abuseStatusReason: string | undefined;
	/** The soft auto-warn state: flagged, but sending still allowed. */
	isWarned: boolean;
	/** Any console write is in flight; every action waits for it. */
	busy: boolean;
	/** `getOrganizationDetail.settings`: the lift condition, the hold and the switch. */
	sending?: SendingStatusView | null;
}>();

const emit = defineEmits<{ setStatus: [initial: AbuseStatus] }>();

const { t, te, locale } = useI18n();

const liftLine = computed(() => {
	const text = suspensionLiftText(props.sending?.suspensionLift, locale.value);
	return text === null ? null : resolveLocalized({ t, te }, text);
});
const holdLine = computed(() => {
	const hold = props.sending?.reputationCheckHold;
	if (!hold || isBlockingAbuseStatus(props.currentAbuseStatus)) return null;
	return reputationHoldText({ t, te }, hold, locale.value);
});

const setResumeMode = useBackendOperation(api.workspaces.settings.update, {
	label: () => t('shared.sendingSuspension.setting.label'),
});
function toggleResumeManual(value: boolean) {
	void setResumeMode.run({ isSendingResumeManual: value });
}

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
				<p v-if="liftLine" class="mt-2 text-sm text-text-primary">{{ liftLine }}</p>
				<p v-if="holdLine" class="mt-2 text-sm text-text-secondary">{{ holdLine }}</p>
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
		<div class="mt-4 pt-4 border-t border-border-subtle flex items-start justify-between gap-4">
			<div class="min-w-0">
				<p class="text-sm text-text-primary">{{ t('shared.sendingSuspension.setting.label') }}</p>
				<p class="mt-1 text-caption text-text-secondary">
					{{ t('shared.sendingSuspension.setting.description') }}
				</p>
			</div>
			<UiSwitch
				:model-value="sending?.isSendingResumeManual === true"
				:label="t('shared.sendingSuspension.setting.label')"
				:disabled="busy || setResumeMode.isLoading.value"
				@update:model-value="toggleResumeManual"
			/>
		</div>
	</div>
</template>
