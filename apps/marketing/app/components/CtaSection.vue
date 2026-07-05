<script setup lang="ts">
const { target, isVisible } = useScrollReveal();
</script>

<template>
	<section
		ref="target"
		class="px-8 max-md:px-6 py-36 max-md:py-24 border-t border-border-subtle"
		:class="{ visible: isVisible }"
	>
		<div class="max-w-[700px] mx-auto text-center">
			<h2
				class="cta-el text-[clamp(2rem,4.5vw,3.25rem)] font-semibold leading-[1.1] tracking-tight text-text-primary mb-5"
				style="--i: 0"
			>
				Start sending better emails today
			</h2>

			<p
				class="cta-el text-base text-text-secondary leading-relaxed max-w-[420px] mx-auto mb-10"
				style="--i: 1"
			>
				Set up your first campaign in minutes. Every feature is included from the start — no feature
				gates, no plan upgrades.
			</p>

			<a
				href="https://app.owlat.app/auth/register"
				class="cta-el group inline-flex items-center gap-2.5 px-8 py-3.5 text-base font-semibold text-text-inverse bg-brand rounded-[10px] no-underline transition-colors duration-(--motion-fast) hover:bg-brand-hover btn-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base"
				style="--i: 2"
			>
				<span>Join Waiting List</span>
				<svg
					class="transition-transform duration-(--motion-fast) group-hover:translate-x-[3px]"
					width="16"
					height="16"
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
			</a>

			<p class="cta-el text-[0.8125rem] text-text-tertiary mt-5" style="--i: 3">
				No long-term contracts. Cancel anytime.
			</p>
		</div>
	</section>
</template>

<style scoped>
/* === Entry reveal: opacity + small translateY only === */
.cta-el {
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
	transition-delay: calc(var(--i, 0) * 0.05s);
}

.visible .cta-el {
	opacity: 1;
	transform: none;
}
</style>
