<script setup lang="ts">
import { useUiI18n } from '../../composables/useUiI18n';
import {
	CircleCheckIcon,
	CircleInfoIcon,
	CircleWarningIcon,
	TriangleWarningIcon,
	type IconComponent,
} from '@coolicons/vue';

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
	actionIcon?: IconComponent;
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
	{ icon: IconComponent; containerClass: string; iconClass: string; messageClass: string }
> = {
	// Literal class strings: a built `${iconClass}/80` is never seen by the
	// Tailwind scanner, so the message would render with no colour at all.
	// Info is the info tone, not brand: brand text is below 4.5:1 in light mode
	// and terracotta is reserved for actions.
	error: {
		icon: CircleWarningIcon,
		containerClass: 'bg-error/10 border-error/20',
		iconClass: 'text-error',
		messageClass: 'text-text-secondary',
	},
	warning: {
		icon: TriangleWarningIcon,
		containerClass: 'bg-warning/10 border-warning/20',
		iconClass: 'text-warning',
		messageClass: 'text-text-secondary',
	},
	info: {
		icon: CircleInfoIcon,
		containerClass: 'bg-info/10 border-info/20',
		iconClass: 'text-info',
		messageClass: 'text-text-secondary',
	},
	success: {
		icon: CircleCheckIcon,
		containerClass: 'bg-success/10 border-success/20',
		iconClass: 'text-success',
		messageClass: 'text-text-secondary',
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
	<div
		:role="variant === 'error' ? 'alert' : 'status'"
		:class="['p-4 border rounded-lg flex items-start gap-3', config.containerClass]"
	>
		<component
			:is="config.icon"
			:class="['w-5 h-5 shrink-0 mt-0.5', config.iconClass]"
			size="1em"
			aria-hidden="true"
		/>
		<div>
			<p :class="['text-sm font-medium', config.iconClass]">{{ displayTitle }}</p>
			<p :class="['text-sm', config.messageClass]">{{ message }}</p>
			<UiButton
				v-if="actionLabel"
				variant="secondary"
				size="sm"
				class="mt-3"
				data-testid="error-alert-action"
				@click="$emit('action')"
			>
				<template v-if="actionIcon" #iconLeft>
					<component :is="actionIcon" class="w-4 h-4" />
				</template>
				{{ actionLabel }}
			</UiButton>
		</div>
	</div>
</template>
