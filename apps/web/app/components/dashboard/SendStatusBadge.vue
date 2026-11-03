<script setup lang="ts">
/**
 * Status pill for an email send (campaign or transactional). Single home for
 * the status icon/variant config that was duplicated across the campaign-send
 * and transactional-send detail pages; they differed only in the fallback
 * status used for unknown values. The pill itself is UiBadge.
 */
import {
	CircleCheckIcon,
	CircleCloseIcon,
	ClockIcon,
	CursorClickIcon,
	EyeIcon,
	PaperPlaneIcon,
	TriangleWarningIcon,
	type IconComponent,
} from '@coolicons/vue';

interface Props {
	status: string;
	/** Status config to fall back to when `status` is not in the map. */
	fallback?: string;
}

const props = withDefaults(defineProps<Props>(), {
	fallback: 'queued',
});

const { t } = useI18n();

type SendStatusVariant = 'default' | 'success' | 'warning' | 'error' | 'neutral';

const STATUS_CONFIG: Record<string, { icon: IconComponent; variant: SendStatusVariant }> = {
	queued: { icon: ClockIcon, variant: 'neutral' },
	sent: { icon: PaperPlaneIcon, variant: 'default' },
	delivered: { icon: CircleCheckIcon, variant: 'success' },
	opened: { icon: EyeIcon, variant: 'default' },
	clicked: { icon: CursorClickIcon, variant: 'warning' },
	bounced: { icon: CircleCloseIcon, variant: 'error' },
	complained: { icon: TriangleWarningIcon, variant: 'error' },
};

const config = computed(
	() => STATUS_CONFIG[props.status] ?? STATUS_CONFIG[props.fallback] ?? STATUS_CONFIG['queued']!
);

/**
 * Translated pill text. A status outside the map keeps the old behaviour — the
 * raw value, capitalized — rather than painting a missing key at a recipient.
 */
const STATUS_LABEL_KEYS: Record<string, string> = {
	queued: 'components.dashboard.sendStatusBadge.status.queued',
	sent: 'components.dashboard.sendStatusBadge.status.sent',
	delivered: 'components.dashboard.sendStatusBadge.status.delivered',
	opened: 'components.dashboard.sendStatusBadge.status.opened',
	clicked: 'components.dashboard.sendStatusBadge.status.clicked',
	bounced: 'components.dashboard.sendStatusBadge.status.bounced',
	complained: 'components.dashboard.sendStatusBadge.status.complained',
};

const label = computed(() => {
	const key = STATUS_LABEL_KEYS[props.status];
	return key ? t(key) : capitalize(props.status);
});
</script>

<template>
	<UiBadge :variant="config.variant" size="md" pill class="shrink-0">
		<template #icon>
			<component :is="config.icon" class="w-3 h-3" />
		</template>
		{{ label }}
	</UiBadge>
</template>
