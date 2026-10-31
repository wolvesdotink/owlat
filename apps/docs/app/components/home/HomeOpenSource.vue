<script setup lang="ts">
/**
 * Open-source callout on the docs home page. The card recipe, reveal styling
 * and stagger come from the page; `.title-accent` and the arrow nudge come
 * from the page's shared type rules.
 */
const { t } = useI18n();
</script>

<template>
	<div class="oss-banner">
		<div class="oss-content">
			<div class="oss-icon-row">
				<svg class="oss-icon" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
					<path
						d="M12 .3a12 12 0 0 0-3.8 23.38c.6.11.82-.26.82-.58l-.01-2.05c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49 1 .1-.78.42-1.3.76-1.6-2.67-.31-5.47-1.34-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6.02 0c2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.18a4.65 4.65 0 0 1 1.24 3.22c0 4.61-2.81 5.62-5.48 5.92.43.37.81 1.1.81 2.22l-.01 3.29c0 .32.21.7.82.58A12 12 0 0 0 12 .3"
					/>
				</svg>
				<span class="oss-label">
					<I18nT keypath="home.oss.label" tag="span" scope="global">
						<template #accent>
							<span class="title-accent">{{ t('home.oss.labelAccent') }}</span>
						</template>
					</I18nT>
				</span>
			</div>
			<p class="oss-description">
				{{ t('home.oss.description') }}
			</p>
			<a
				href="https://github.com/wolvesdotink/owlat"
				target="_blank"
				rel="noopener noreferrer"
				class="btn btn-hairline btn-sm group oss-link no-underline"
			>
				<span>{{ t('home.oss.cta') }}</span>
				<svg
					class="arrow-nudge"
					width="14"
					height="14"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M3.33 8h9.34M8.67 4l4 4-4 4" />
				</svg>
			</a>
		</div>
	</div>
</template>

<style scoped>
.oss-banner {
	display: block;
	padding: 32px 36px;
}

.oss-content {
	max-width: 520px;
}

.oss-icon-row {
	display: flex;
	align-items: center;
	gap: 10px;
}

.oss-icon {
	color: var(--color-text-primary);
}

.oss-label {
	font-size: 1.25rem;
	font-weight: 450;
	letter-spacing: -0.01em;
	color: var(--color-text-primary);
}

.oss-description {
	margin-top: 10px;
	font-size: var(--text-md);
	line-height: 1.6;
	color: var(--color-text-secondary);
}

.oss-link {
	margin-top: 18px;
}
</style>
