<script setup lang="ts">
const { target, isVisible } = useScrollReveal();

// Floating feature tags that orbit the CTA
const features = ['Campaigns', 'Automations', 'Transactional', 'A/B Testing', 'Segments', 'Templates'];
</script>

<template>
	<section
		ref="target"
		class="relative px-8 max-md:px-6 py-36 max-md:py-24 overflow-hidden"
		:class="{ visible: isVisible }"
	>
		<!-- Decorative grid pattern -->
		<div class="cta-grid absolute inset-0 pointer-events-none" aria-hidden="true" />

		<div class="relative max-w-[700px] mx-auto text-center">
			<div class="cta-el mb-8" style="--i: 0">
				<OwlLogo size="72px" class="mx-auto cta-logo" />
			</div>

			<h2 class="cta-el font-display text-[clamp(2rem,5vw,3.5rem)] font-normal leading-[1.1] tracking-[-0.02em] text-text-primary mb-5" style="--i: 1">
				Start sending<br>
				<em class="italic">better</em> emails today
			</h2>

			<p class="cta-el text-base text-text-secondary leading-relaxed max-w-[420px] mx-auto mb-8" style="--i: 2">
				Set up your first campaign in minutes. Every feature is included from the start — no feature gates, no plan upgrades.
			</p>

			<!-- Floating feature tags -->
			<div class="cta-el flex flex-wrap justify-center gap-2 mb-10 max-w-[480px] mx-auto" style="--i: 3">
				<span
					v-for="(feature, i) in features" :key="feature"
					class="feature-tag inline-flex items-center px-3 py-1 rounded-full text-xs font-medium text-text-tertiary border border-border-default transition-all duration-(--motion-moderate) hover:border-brand/30 hover:text-brand hover:bg-brand-soft cursor-default"
					:style="{ animationDelay: `${i * 0.12}s` }"
				>
					{{ feature }}
				</span>
			</div>

			<a
				href="https://app.owlat.app/auth/register"
				class="cta-el cta-btn group inline-flex items-center gap-2.5 px-8 py-3.5 text-base font-semibold text-text-inverse bg-brand border border-brand rounded-xl no-underline transition-all duration-(--motion-moderate) hover:bg-brand-hover hover:border-brand-hover hover:shadow-brand-hover btn-press relative"
				style="--i: 4"
			>
				<span>Join Waiting List</span>
				<svg
					class="transition-transform duration-(--motion-moderate) group-hover:translate-x-[3px]"
					width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
				>
					<path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
				</svg>
			</a>

			<p class="cta-el text-[0.8125rem] text-text-disabled mt-5" style="--i: 5">
				No long-term contracts. Cancel anytime.
			</p>
		</div>
	</section>
</template>

<style scoped>
.cta-el {
	opacity: 0;
	transform: translateY(18px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--i, 0) * 0.08s);
}

.visible .cta-el {
	opacity: 1;
	transform: none;
}

/* Feature tags gentle entrance */
.visible .feature-tag {
	animation: tag-float var(--motion-slow) var(--ease-spring) backwards;
}

@keyframes tag-float {
	from {
		opacity: 0;
		transform: translateY(4px);
	}
}

/* CTA button glow */
.cta-btn::after {
	content: '';
	position: absolute;
	inset: -2px;
	border-radius: inherit;
	background: var(--color-brand);
	opacity: 0;
	z-index: -1;
	filter: blur(16px);
	transition: opacity var(--motion-slow) var(--ease-spring);
}

.cta-btn:hover::after {
	opacity: 0.3;
}

/* Decorative dot grid */
.cta-grid {
	background-image: radial-gradient(circle, var(--color-border-subtle) 1px, transparent 1px);
	background-size: 40px 40px;
	opacity: 0;
	transition: opacity 1s ease var(--motion-moderate);
	mask-image: radial-gradient(ellipse 50% 60% at 50% 50%, black 20%, transparent 70%);
	-webkit-mask-image: radial-gradient(ellipse 50% 60% at 50% 50%, black 20%, transparent 70%);
}

.visible .cta-grid {
	opacity: 1;
}
</style>
