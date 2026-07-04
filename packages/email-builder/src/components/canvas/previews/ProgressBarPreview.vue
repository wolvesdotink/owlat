<script setup lang="ts">
import { computed } from 'vue';
import type { EditorBlock, EmailTheme, ProgressBarBlockContent } from '../../../types';

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
}>();

const content = computed(() => props.block.content as ProgressBarBlockContent);

const maxValue = computed(() => content.value.maxValue ?? 100);
const percentage = computed(() => Math.min(100, Math.max(0, ((content.value.value ?? 0) / maxValue.value) * 100)));
const rounded = computed(() => Math.round(percentage.value));

const wrapperStyles = computed(() => ({
	paddingTop: `${content.value.paddingTop ?? 16}px`,
	paddingRight: `${content.value.paddingRight ?? 24}px`,
	paddingBottom: `${content.value.paddingBottom ?? 16}px`,
	paddingLeft: `${content.value.paddingLeft ?? 24}px`,
	marginTop: `${content.value.marginTop ?? 0}px`,
	marginRight: `${content.value.marginRight ?? 0}px`,
	marginBottom: `${content.value.marginBottom ?? 0}px`,
	marginLeft: `${content.value.marginLeft ?? 0}px`,
}));

const borderRadius = computed(() => content.value.borderRadius ?? 0);
const barColor = computed(() => content.value.barColor || '#4CAF50');
const labelColor = computed(() => content.value.labelColor || '#333333');
const labelFontSize = computed(() => content.value.labelFontSize ?? 14);
const labelPosition = computed(() => content.value.labelPosition || 'right');
const height = computed(() => content.value.height || 20);

const trackStyles = computed(() => ({
	height: `${height.value}px`,
	backgroundColor: content.value.trackColor || '#e0e0e0',
	borderRadius: `${borderRadius.value}px`,
	overflow: 'hidden',
	position: 'relative' as const,
}));

const barStyles = computed(() => {
	const rFull = borderRadius.value > 0 ? `${borderRadius.value}px` : '0';
	const rLeft = borderRadius.value > 0 ? `${borderRadius.value}px 0 0 ${borderRadius.value}px` : '0';

	let radius: string;
	if (rounded.value >= 100) {
		radius = rFull;
	} else if (rounded.value <= 0) {
		radius = '0';
	} else {
		radius = rLeft;
	}

	return {
		width: `${rounded.value}%`,
		height: '100%',
		backgroundColor: barColor.value,
		borderRadius: radius,
		transition: 'width var(--motion-moderate) ease',
		position: 'relative' as const,
	};
});

const showInsideLabel = computed(() =>
	content.value.showLabel && labelPosition.value === 'inside' && percentage.value > 15
);
</script>

<template>
	<div :style="wrapperStyles">
		<div class="flex items-center gap-2">
			<div :style="trackStyles" class="flex-1">
				<div :style="barStyles">
					<span
						v-if="showInsideLabel"
						:style="{
							color: '#ffffff',
							fontSize: `${Math.min(labelFontSize, height - 4)}px`,
							lineHeight: `${height}px`,
							padding: '0 8px',
							whiteSpace: 'nowrap',
						}"
					>{{ rounded }}%</span>
				</div>
			</div>
			<span
				v-if="content.showLabel && labelPosition === 'right'"
				class="shrink-0"
				:style="{
					color: labelColor,
					fontSize: `${labelFontSize}px`,
					fontWeight: '500',
					whiteSpace: 'nowrap',
				}"
			>{{ rounded }}%</span>
		</div>
	</div>
</template>
