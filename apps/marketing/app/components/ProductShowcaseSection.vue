<script setup lang="ts">
/* Product showcase — a stacked composition of in-code mock frames (the repo's
 * marketing convention; see showcase/*Frame.vue). Each frame is self-contained
 * so it can later be swapped for a real capture <img> without touching this
 * section. */
const { target, isVisible } = useScrollReveal();
</script>

<template>
	<section
		id="product"
		ref="target"
		class="px-8 max-md:px-6 py-28 max-md:py-20 overflow-hidden"
		:class="{ visible: isVisible }"
	>
		<div class="max-w-[1200px] mx-auto">
			<!-- Section header -->
			<div class="mb-16 max-md:mb-12 text-center flex flex-col items-center">
				<span class="show-el lp-eyebrow mb-4" style="--i: 0">Product</span>
				<h2 class="show-el lp-title mb-4" style="--i: 1">
					One calm surface for<br class="max-md:hidden" />
					<span class="lp-title-accent">all</span> of your email
				</h2>
				<p
					class="show-el text-base text-text-secondary leading-relaxed max-w-[540px]"
					style="--i: 2"
				>
					The mail client, campaign reports, and deliverability tooling live in one light workspace
					— no tab juggling between tools.
				</p>
			</div>

			<!-- Screen-reader description of the decorative composition -->
			<p class="sr-only">
				Product previews: the Postbox mail client with a folder rail, thread list and reading pane;
				a campaign report with send, open and click statistics; and the deliverability dashboard
				showing SPF, DKIM and DMARC checks, the own-MTA sending share, and seed placement results.
			</p>

			<!-- Stacked frames (decorative) -->
			<div
				class="show-el showcase-stack relative mx-auto max-w-[880px]"
				style="--i: 3"
				aria-hidden="true"
			>
				<!-- Back left: campaigns -->
				<div
					class="stack-side stack-left hidden lg:block absolute left-[-96px] top-16 w-[440px] z-0"
				>
					<ShowcaseCampaignsFrame />
				</div>
				<!-- Back right: deliverability -->
				<div
					class="stack-side stack-right hidden lg:block absolute right-[-96px] top-20 w-[440px] z-0"
				>
					<ShowcaseDeliverabilityFrame />
				</div>
				<!-- Front center: mail client -->
				<div class="relative z-10 mx-auto w-full max-w-[680px]">
					<ShowcaseMailFrame />
				</div>
			</div>
		</div>
	</section>
</template>

<style scoped>
/* === Entry reveal: opacity + small translateY only === */
.show-el {
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
	transition-delay: calc(var(--i, 0) * 0.05s);
}

.visible .show-el {
	opacity: 1;
	transform: none;
}

/* === Back frames: slight rotate/translate, slide outward on hover === */
.stack-side {
	transition: transform var(--motion-slow) var(--ease-spring);
	filter: drop-shadow(0 24px 48px rgba(0, 0, 0, 0.08));
}

.stack-left {
	transform: rotate(-4deg) translateY(0);
}

.stack-right {
	transform: rotate(4deg) translateY(0);
}

.showcase-stack:hover .stack-left {
	transform: rotate(-5deg) translateX(-20px);
}

.showcase-stack:hover .stack-right {
	transform: rotate(5deg) translateX(20px);
}

@media (prefers-reduced-motion: reduce) {
	.showcase-stack:hover .stack-left {
		transform: rotate(-4deg);
	}
	.showcase-stack:hover .stack-right {
		transform: rotate(4deg);
	}
}
</style>
