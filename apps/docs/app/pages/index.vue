<script setup lang="ts">
import { docsHomePopularGuides, docsHomeSections } from '../utils/docsHome';

definePageMeta({ layout: 'home' });

const { t } = useI18n();
const localePath = useLocalePath();

// Getters: the strings are read when the tags are rendered, not frozen at the
// locale that happened to be active while this component was setting up.
useSeoMeta({
	title: () => t('home.seo.title'),
	ogTitle: () => t('home.seo.title'),
	description: () => t('home.seo.description'),
	ogDescription: () => t('home.seo.description'),
});

defineOgImage('Docs', { title: t('brand.docs'), description: t('home.seo.ogDescription') });

const visible = ref(false);

const { target: linksRef, isVisible: linksVisible } = useScrollReveal();
const { target: guidesRef, isVisible: guidesVisible } = useScrollReveal();
const { target: codeRef, isVisible: codeVisible } = useScrollReveal();
const { target: ossRef, isVisible: ossVisible } = useScrollReveal();

onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true;
	});
});

const sections = computed(() =>
	docsHomeSections.map(({ key, path, icon }) => ({ key, href: localePath(path), icon }))
);

const popularGuides = computed(() =>
	docsHomePopularGuides.map(({ key, path }) => ({ key, href: localePath(path) }))
);
</script>

<template>
	<div :class="['landing', { visible }]">
		<!-- Hero -->
		<HomeHero />

		<!-- Quick Links -->
		<section ref="linksRef" :class="['quick-links-section', { visible: linksVisible }]">
			<div class="section-container">
				<div class="sections-grid">
					<NuxtLink
						v-for="(section, i) in sections"
						:key="section.key"
						:to="section.href"
						class="section-card reveal-item"
						:style="{ '--i': i }"
					>
						<div class="section-card-header">
							<div class="section-icon">
								<svg
									width="18"
									height="18"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="1.5"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path :d="section.icon" />
								</svg>
							</div>
							<span class="section-label">{{ t(`home.sections.${section.key}.label`) }}</span>
							<span class="section-count">{{ t(`home.sections.${section.key}.count`) }}</span>
						</div>
						<p class="section-description">
							{{ t(`home.sections.${section.key}.description`) }}
						</p>
						<svg
							class="section-arrow"
							width="16"
							height="16"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M3.33 8h9.34M8.67 4l4 4-4 4" />
						</svg>
					</NuxtLink>
				</div>
			</div>
		</section>

		<!-- Popular Guides -->
		<section ref="guidesRef" :class="['popular-section', { visible: guidesVisible }]">
			<div class="section-container">
				<div class="section-header reveal-item" :style="{ '--i': 0 }">
					<span class="eyebrow">{{ t('home.popular.eyebrow') }}</span>
					<h2 class="section-title">
						<I18nT keypath="home.popular.title" tag="span" scope="global">
							<template #accent>
								<span class="title-accent">{{ t('home.popular.titleAccent') }}</span>
							</template>
						</I18nT>
					</h2>
				</div>
				<div class="guides-grid">
					<NuxtLink
						v-for="(guide, i) in popularGuides"
						:key="guide.key"
						:to="guide.href"
						class="guide-card reveal-item"
						:style="{ '--i': i + 1 }"
					>
						<h3 class="guide-title">{{ t(`home.guides.${guide.key}.title`) }}</h3>
						<p class="guide-description">{{ t(`home.guides.${guide.key}.description`) }}</p>
						<svg
							class="guide-arrow"
							width="14"
							height="14"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M3.33 8h9.34M8.67 4l4 4-4 4" />
						</svg>
					</NuxtLink>
				</div>
			</div>
		</section>

		<!-- Code Preview -->
		<section ref="codeRef" :class="['code-section', { visible: codeVisible }]">
			<div class="section-container">
				<div class="section-header reveal-item" :style="{ '--i': 0 }">
					<span class="eyebrow">{{ t('home.quickstart.eyebrow') }}</span>
					<h2 class="section-title">
						<I18nT keypath="home.quickstart.title" tag="span" scope="global">
							<template #accent>
								<span class="title-accent">{{ t('home.quickstart.titleAccent') }}</span>
							</template>
						</I18nT>
					</h2>
				</div>

				<HomeCodePreview class="reveal-item" :style="{ '--i': 1 }" />
			</div>
		</section>

		<!-- Open Source Callout -->
		<section ref="ossRef" :class="['oss-section', { visible: ossVisible }]">
			<div class="section-container">
				<HomeOpenSource class="reveal-item" :style="{ '--i': 0 }" />
			</div>
		</section>

		<!-- Footer -->
		<footer class="landing-footer">
			<div class="section-container">
				<p class="footer-copy">
					<I18nT keypath="footer.copyright" tag="span" scope="global">
						<template #year>{{ new Date().getFullYear() }}</template>
						<template #company><a href="https://wolves.ink">Wolves</a></template>
					</I18nT>
				</p>
			</div>
		</footer>
	</div>
</template>

<style scoped>
/* ── Layout ── */
.landing {
	overflow-x: hidden;
}

.section-container {
	max-width: 1120px;
	margin: 0 auto;
	padding: 0 24px;
}

/*
 * Section rhythm: eyebrow → title → sub.
 *
 * `.eyebrow`, `.title-accent` and the arrow nudge are also used inside
 * `HomeHero` and `HomeOpenSource`, so these rules reach into them with
 * `:deep()` to keep one definition. Nothing else sets these properties on
 * those elements, so the extra specificity does not change the cascade.
 */
.landing :deep(.eyebrow) {
	display: block;
	font-size: var(--text-caption);
	line-height: var(--text-caption--line-height);
	font-weight: 450;
	text-transform: uppercase;
	letter-spacing: 0.1em;
	color: var(--color-text-tertiary);
}

.section-title {
	font-size: clamp(1.5rem, 3vw, 2rem);
	font-weight: 450;
	letter-spacing: -0.02em;
	line-height: 1.15;
	color: var(--color-text-primary);
	margin-top: 8px;
}

.landing :deep(.title-accent) {
	font-family: var(--font-display);
	font-style: italic;
	font-weight: 400;
	letter-spacing: -0.01em;
}

.section-header {
	margin-bottom: 28px;
}

/* ── Scroll Reveal ── */
.reveal-item {
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--i, 0) * 0.05s);
}

.visible .reveal-item {
	opacity: 1;
	transform: translateY(0);
}

/* Arrow nudge inside pill CTAs / links */
.landing :deep(.arrow-nudge) {
	transition: transform var(--motion-fast) var(--ease-spring);
}

.landing :deep(.group:hover .arrow-nudge) {
	transform: translateX(3px);
}

/* ── Cards (shared recipe: white, hairline, hover lift) ── */
.section-card,
.guide-card,
.oss-banner {
	background: var(--surface-3);
	border: 1px solid var(--color-border-subtle);
	border-radius: var(--radius-card);
	box-shadow: var(--shadow-1);
	text-decoration: none;
	transition:
		border-color var(--motion-fast) var(--ease-spring),
		box-shadow var(--motion-fast) var(--ease-spring);
}

.section-card:hover,
.guide-card:hover,
.oss-banner:hover {
	border-color: var(--color-border-default);
	box-shadow: var(--shadow-3);
}

/* ── Quick Links ── */
.quick-links-section {
	padding: 0 0 64px;
}

.sections-grid {
	display: grid;
	grid-template-columns: 3fr 2fr;
	gap: 14px;
}

.section-card {
	position: relative;
	display: block;
	padding: 22px 24px;
}

.section-card-header {
	display: flex;
	align-items: center;
	gap: 10px;
}

.section-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	border-radius: 10px;
	background: var(--color-brand-soft);
	color: var(--color-brand);
	transition: background var(--motion-fast) var(--ease-spring);
}

.section-card:hover .section-icon {
	background: color-mix(in srgb, var(--color-brand) 15%, transparent);
}

.section-label {
	font-size: 16px;
	font-weight: 550;
	color: var(--color-text-primary);
}

.section-count {
	font-size: var(--text-2xs);
	font-weight: 450;
	padding: 2px 9px;
	border-radius: 9999px;
	color: var(--color-text-tertiary);
	border: 1px solid var(--color-border-subtle);
}

.section-description {
	margin-top: 6px;
	font-size: 14.5px;
	line-height: 1.5;
	color: var(--color-text-secondary);
	padding-left: 42px;
}

.section-arrow {
	position: absolute;
	top: 22px;
	right: 20px;
	color: var(--color-text-tertiary);
	opacity: 0;
	transform: translateX(-4px);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
}

.section-card:hover .section-arrow {
	opacity: 1;
	transform: translateX(0);
}

/* ── Popular Guides ── */
.popular-section {
	padding: 0 0 80px;
}

.guides-grid {
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: 14px;
}

.guide-card {
	position: relative;
	display: block;
	padding: 20px 22px;
}

.guide-title {
	font-size: 16px;
	font-weight: 550;
	color: var(--color-text-primary);
	transition: color var(--motion-fast) var(--ease-spring);
}

.guide-card:hover .guide-title {
	color: var(--color-brand);
}

.guide-description {
	margin-top: 4px;
	font-size: 14px;
	line-height: 1.5;
	color: var(--color-text-secondary);
}

.guide-arrow {
	position: absolute;
	top: 20px;
	right: 18px;
	color: var(--color-text-tertiary);
	opacity: 0;
	transform: translateX(-4px);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
}

.guide-card:hover .guide-arrow {
	opacity: 1;
	transform: translateX(0);
}

/* ── Code Preview ── */
.code-section {
	padding: 0 0 80px;
}

/* ── Open Source ── */
.oss-section {
	padding: 0 0 64px;
}

/* ── Footer ── */
.landing-footer {
	padding: 32px 0;
	border-top: 1px solid var(--color-border-subtle);
}

.footer-copy {
	font-size: 14px;
	color: var(--color-text-tertiary);
}

/* ── Responsive ── */
@media (max-width: 860px) {
	.sections-grid {
		grid-template-columns: 1fr;
	}

	.guides-grid {
		grid-template-columns: repeat(2, 1fr);
	}
}

@media (max-width: 580px) {
	.guides-grid {
		grid-template-columns: 1fr;
	}

	.section-description {
		padding-left: 0;
	}
}
</style>
