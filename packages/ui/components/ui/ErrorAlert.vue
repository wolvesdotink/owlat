<script setup lang="ts">
import { useUiI18n } from '../../composables/useUiI18n';

type AlertVariant = 'error' | 'warning' | 'info' | 'success';

interface Props {
	message: string;
	title?: string;
	variant?: AlertVariant;
	/**
	 * Label for an optional action button under the message, e.g. "Try again"
	 * wired to a query's refetch. Copy that tells the user to try again needs a
	 * control to do it with.
	 */
	actionLabel?: string;
	/** Icon for the action button. */
	actionIcon?: string;
}

const props = withDefaults(defineProps<Props>(), {
	title: undefined,
	variant: 'error',
	actionLabel: undefined,
	actionIcon: undefined,
});

defineEmits<{
	/** The action button was clicked. */
	action: [];
}>();

const variantConfig: Record<
	AlertVariant,
	{ icon: string; containerClass: string; iconClass: string }
> = {
	error: {
		icon: 'lucide:alert-circle',
		containerClass: 'bg-error/10 border-error/20',
		iconClass: 'text-error',
	},
	warning: {
		icon: 'lucide:alert-triangle',
		containerClass: 'bg-warning/10 border-warning/20',
		iconClass: 'text-warning',
	},
	info: {
		icon: 'lucide:info',
		containerClass: 'bg-brand/10 border-brand/20',
		iconClass: 'text-brand',
	},
	success: {
		icon: 'lucide:check-circle',
		containerClass: 'bg-success/10 border-success/20',
		iconClass: 'text-success',
	},
};

const config = computed(() => variantConfig[props.variant]);

const { t } = useUiI18n();

// One key per variant (not a built `ui.alert.${variant}` path) so the catalog
// keys stay greppable and the parity test can see every one of them.
const defaultTitleKeys: Record<AlertVariant, string> = {
	error: 'ui.alert.error',
	warning: 'ui.alert.warning',
	info: 'ui.alert.info',
	success: 'ui.alert.success',
};

const displayTitle = computed(() => props.title ?? t(defaultTitleKeys[props.variant]));
</script>

<template>
	<div :class="['p-4 border rounded-lg flex items-start gap-3', config.containerClass]">
		<Icon :name="config.icon" :class="['w-5 h-5 shrink-0 mt-0.5', config.iconClass]" />
		<div>
			<p :class="['text-sm font-medium', config.iconClass]">{{ displayTitle }}</p>
			<p :class="['text-sm', `${config.iconClass}/80`]">{{ message }}</p>
			<UiButton
				v-if="actionLabel"
				variant="secondary"
				size="sm"
				class="mt-3"
				data-testid="error-alert-action"
				@click="$emit('action')"
			>
				<template v-if="actionIcon" #iconLeft>
					<Icon :name="actionIcon" class="w-4 h-4" />
				</template>
				{{ actionLabel }}
			</UiButton>
		</div>
	</div>
</template>
