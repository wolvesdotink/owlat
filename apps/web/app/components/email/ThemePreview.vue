<script setup lang="ts">
/**
 * The live email preview beside the email-theme form: one sample message
 * painted with the theme currently in the form, so an operator sees the effect
 * of a colour before saving it.
 *
 * Extracted from `pages/dashboard/admin/instance/email-theme.vue`, which grew
 * past the 500-LOC split guideline. The seam is the natural one — everything
 * here reads the theme and nothing writes it — and it takes the two contrast
 * computations with it, since they exist only to keep this sample legible.
 */
const { t } = useI18n();

const props = defineProps<{
	primaryColor: string;
	fontFamily: string;
	backgroundColor: string;
	baseWidth: number;
}>();

/** Perceived luminance of a `#rrggbb` fill, 0 (black) … 1 (white). */
function luminanceOf(hex: string): number {
	const value = hex.replace('#', '');
	const r = parseInt(value.substring(0, 2), 16);
	const g = parseInt(value.substring(2, 4), 16);
	const b = parseInt(value.substring(4, 6), 16);
	return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// Text colour for the sample body: dark ink on a light background, light ink on
// a dark one. Literal hexes because this is EMAIL markup — the sample has to
// look the way the rendered message will, not the way the app chrome does.
const previewTextColor = computed(() =>
	luminanceOf(props.backgroundColor) > 0.5 ? '#374151' : '#f3f4f6'
);

const buttonTextColor = computed(() =>
	luminanceOf(props.primaryColor) > 0.5 ? '#12110e' : '#ffffff'
);
</script>

<template>
	<div class="card p-0 overflow-hidden">
		<div class="px-6 py-4 border-b border-border-subtle">
			<h2 class="text-lg font-semibold text-text-primary">{{ t('common.preview') }}</h2>
			<p class="text-sm text-text-secondary">
				{{ t('dashboard.admin.instance.emailTheme.previewSubtitle') }}
			</p>
		</div>

		<div class="p-6">
			<!-- Email Preview Container -->
			<div
				class="rounded-xl overflow-hidden border border-border-subtle mx-auto transition-all duration-(--motion-moderate)"
				:style="{ backgroundColor, maxWidth: baseWidth + 'px' }"
			>
				<!-- Email Content Preview -->
				<div class="p-8">
					<!-- Header Text -->
					<h1 class="text-2xl font-bold mb-4" :style="{ fontFamily, color: previewTextColor }">
						{{ t('dashboard.admin.instance.emailTheme.preview.heading') }}
					</h1>

					<!-- Body Text -->
					<p class="mb-6 leading-relaxed" :style="{ fontFamily, color: previewTextColor }">
						{{ t('dashboard.admin.instance.emailTheme.preview.body') }}
					</p>

					<!-- Button Preview -->
					<button
						class="px-6 py-3 rounded-lg font-semibold transition-all"
						:style="{ backgroundColor: primaryColor, color: buttonTextColor, fontFamily }"
					>
						{{ t('dashboard.admin.instance.emailTheme.preview.button') }}
					</button>

					<!-- Footer Text -->
					<p class="mt-8 text-sm opacity-70" :style="{ fontFamily, color: previewTextColor }">
						{{ t('dashboard.admin.instance.emailTheme.preview.footer') }}
					</p>
				</div>
			</div>

			<!-- Preview Note -->
			<p class="mt-4 text-xs text-text-tertiary text-center">
				{{ t('dashboard.admin.instance.emailTheme.preview.note') }}
			</p>
		</div>
	</div>
</template>
