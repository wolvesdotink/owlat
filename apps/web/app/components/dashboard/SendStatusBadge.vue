<script setup lang="ts">
/**
 * Status pill for an email send (campaign or transactional). Single home for
 * the status icon/color config + pill markup that was duplicated across the
 * campaign-send and transactional-send detail pages; they differed only in the
 * fallback status used for unknown values.
 */
interface Props {
	status: string;
	/** Status config to fall back to when `status` is not in the map. */
	fallback?: string;
}

const props = withDefaults(defineProps<Props>(), {
	fallback: 'queued',
});

const { t } = useI18n();

const STATUS_CONFIG: Record<string, { icon: string; color: string; bg: string }> = {
	queued: { icon: 'lucide:clock', color: 'text-text-secondary', bg: 'bg-bg-surface' },
	sent: { icon: 'lucide:send', color: 'text-brand', bg: 'bg-brand/10' },
	delivered: { icon: 'lucide:check-circle-2', color: 'text-success', bg: 'bg-success/10' },
	opened: { icon: 'lucide:eye', color: 'text-brand', bg: 'bg-brand/10' },
	clicked: { icon: 'lucide:mouse-pointer-click', color: 'text-warning', bg: 'bg-warning/10' },
	bounced: { icon: 'lucide:x-circle', color: 'text-error', bg: 'bg-error/10' },
	complained: { icon: 'lucide:alert-triangle', color: 'text-error', bg: 'bg-error/10' },
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
	<span
		:class="[
			'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium flex-shrink-0',
			config.bg,
			config.color,
		]"
	>
		<Icon :name="config.icon" class="w-3 h-3" />
		{{ label }}
	</span>
</template>
