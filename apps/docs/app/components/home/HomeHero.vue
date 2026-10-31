<script setup lang="ts">
/**
 * Docs home hero: headline, the two entry CTAs and the quickstart snippet.
 * The entrance stagger keys off the page's `.visible` root; `.eyebrow`,
 * `.title-accent` and the arrow nudge come from the page's shared type rules.
 */
const { t } = useI18n();
const localePath = useLocalePath();
</script>

<template>
	<section class="hero-section">
		<div class="hero-aurora" aria-hidden="true" />
		<div class="hero-container">
			<div class="hero-grid">
				<!-- Left column -->
				<div class="hero-content">
					<span class="eyebrow anim-badge">{{ t('home.hero.eyebrow') }}</span>

					<h1 class="hero-title anim-title">
						<I18nT keypath="home.hero.title" tag="span" scope="global">
							<template #accent>
								<span class="title-accent title-warm">{{ t('home.hero.titleAccent') }}</span>
							</template>
						</I18nT>
					</h1>

					<p class="hero-tagline anim-tagline">
						{{ t('home.hero.tagline') }}
					</p>

					<div class="hero-actions anim-actions">
						<NuxtLink
							:to="localePath('/guide/getting-started')"
							class="btn btn-primary group no-underline"
						>
							<span>{{ t('home.hero.startGuide') }}</span>
							<svg
								class="arrow-nudge"
								width="15"
								height="15"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2.5"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="M5 12h14" />
								<path d="m12 5 7 7-7 7" />
							</svg>
						</NuxtLink>
						<NuxtLink :to="localePath('/api')" class="btn btn-hairline group no-underline">
							<span>{{ t('home.hero.exploreApi') }}</span>
							<svg
								class="arrow-nudge"
								width="15"
								height="15"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2.5"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<path d="M5 12h14" />
								<path d="m12 5 7 7-7 7" />
							</svg>
						</NuxtLink>
					</div>
				</div>

				<!-- Right column: SDK snippet -->
				<div class="hero-snippet anim-snippet">
					<div class="snippet-card">
						<HomeWindowChrome file="quickstart.ts" />
						<div class="snippet-body">
							<HomeCodeSample sample="quickstart" />
						</div>
					</div>
				</div>
			</div>
		</div>
	</section>
</template>

<style scoped>
/* Warm gradient for the hero's display phrase. */
.title-warm {
	background: linear-gradient(100deg, var(--color-text-primary) 15%, var(--color-brand) 80%);
	-webkit-background-clip: text;
	background-clip: text;
	color: transparent;
}

/* ── Hero ── */
.hero-section {
	position: relative;
	padding: 96px 0 72px;
	overflow: hidden;
}

/* Restrained bottom aurora — static terracotta wash anchored below the fold */
.hero-aurora {
	position: absolute;
	left: 18%;
	right: 18%;
	bottom: -34vh;
	height: 40vh;
	border-radius: 50%;
	filter: blur(120px);
	background: radial-gradient(ellipse closest-side, rgba(196, 120, 90, 0.16), transparent 72%);
	pointer-events: none;
}

.hero-container {
	position: relative;
	max-width: 1120px;
	margin: 0 auto;
	padding: 0 24px;
	z-index: 1;
}

.hero-grid {
	display: grid;
	grid-template-columns: 1.15fr 0.85fr;
	gap: 48px;
	align-items: center;
}

.hero-title {
	margin-top: 16px;
	font-size: clamp(2.25rem, 4.5vw, 3.25rem);
	font-weight: 450;
	letter-spacing: -0.02em;
	line-height: 1.12;
	color: var(--color-text-primary);
}

.hero-title .title-accent {
	display: block;
	padding-bottom: 2px;
}

.hero-tagline {
	margin-top: 18px;
	font-size: var(--text-md);
	line-height: 1.65;
	color: var(--color-text-secondary);
	max-width: 480px;
}

.hero-actions {
	display: flex;
	gap: 12px;
	margin-top: 32px;
	flex-wrap: wrap;
}

/* ── Hero Snippet ── */
.snippet-card {
	border-radius: var(--radius-card);
	overflow: hidden;
	background: var(--surface-3);
	border: 1px solid var(--color-border-subtle);
	box-shadow: var(--shadow-4);
}

.snippet-body {
	padding: 18px 20px;
	overflow-x: auto;
}

/* ── Entrance Animations ── */
.anim-badge,
.anim-title,
.anim-tagline,
.anim-actions,
.anim-snippet {
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
}

.anim-snippet {
	transform: translateY(12px);
}

.visible .anim-badge {
	opacity: 1;
	transform: translateY(0);
	transition-delay: 0.05s;
}

.visible .anim-title {
	opacity: 1;
	transform: translateY(0);
	transition-delay: 0.1s;
}

.visible .anim-tagline {
	opacity: 1;
	transform: translateY(0);
	transition-delay: 0.18s;
}

.visible .anim-actions {
	opacity: 1;
	transform: translateY(0);
	transition-delay: 0.26s;
}

.visible .anim-snippet {
	opacity: 1;
	transform: translateY(0);
	transition-delay: 0.22s;
}

/* ── Responsive ── */
@media (max-width: 860px) {
	.hero-grid {
		grid-template-columns: 1fr;
		gap: 36px;
	}
}

@media (max-width: 580px) {
	.hero-section {
		padding: 64px 0 48px;
	}

	.hero-actions {
		flex-direction: column;
		align-items: stretch;
	}
}
</style>
