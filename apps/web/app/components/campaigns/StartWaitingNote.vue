<script setup lang="ts">
// Why a scheduled campaign past its start time has not started, and when the
// start gate stops waiting for it (`campaigns/startGate.ts`). The editor and
// the report header put this inside their own `role="status"` region, so the
// change from "scheduled" to "waiting" is announced.
import { useFormat } from '~/composables/useFormat';
import { useNow } from '~/composables/useNow';
import {
	startHoldGivesUpAt,
	startHoldReasonKey,
	type StoredStartHold,
} from '~/utils/campaignStartHold';

const props = defineProps<{ hold: StoredStartHold }>();

const { t } = useI18n();
const { formatRelativeTime } = useFormat();
// The give-up time is counted down in minutes, so the line moves while the page sits open.
const now = useNow({ intervalMs: 60_000 });

const givesUpWhen = computed(() => formatRelativeTime(startHoldGivesUpAt(props.hold, now.value)));
</script>

<template>
	<p class="text-sm text-text-secondary">{{ t(startHoldReasonKey(hold)) }}</p>
	<p class="text-sm text-text-secondary">
		{{ t('shared.campaignStartHold.givesUp', { when: givesUpWhen }) }}
	</p>
</template>
