<script setup lang="ts">
/**
 * Shared hero shell for the auth screens: the marketing site's background
 * field (hairline grid + grain + aurora) behind a hairline card, with the
 * serif display accent available in the heading via the #title slot. Keeps
 * login / register / forgot / reset visually in lockstep with the landing
 * pages while each page keeps its own form logic.
 */
defineProps<{
	/** Optional line under the heading. */
	subtitle?: string;
}>();
</script>

<template>
	<div
		class="relative isolate flex min-h-screen flex-col items-center justify-center overflow-hidden bg-bg-base px-4 py-16"
	>
		<!-- Decorative field — behind the content, ignores the pointer, hidden from AT. -->
		<div class="absolute inset-0 hero-grid" aria-hidden="true" />
		<div class="absolute inset-0 hero-grain" aria-hidden="true" />
		<div class="absolute inset-0 overflow-hidden" aria-hidden="true">
			<div class="lp-aurora lp-aurora-gold" />
			<div class="lp-aurora lp-aurora-core" />
		</div>

		<div class="relative w-full max-w-md">
			<div class="lp-hero-in mb-8 text-center" style="--i: 0">
				<img src="/owlat.svg" alt="" class="mx-auto mb-5 size-12" />
				<h1 class="text-3xl font-medium tracking-[-0.02em] text-text-primary">
					<slot name="title" />
				</h1>
				<p v-if="subtitle" class="mt-2 text-md leading-[1.65] text-text-secondary">
					{{ subtitle }}
				</p>
			</div>

			<div class="lp-card lp-hero-in p-8 max-sm:p-6" style="--i: 1">
				<slot />
			</div>

			<div
				v-if="$slots.footer"
				class="lp-hero-in mt-6 text-center text-sm text-text-secondary"
				style="--i: 2"
			>
				<slot name="footer" />
			</div>
		</div>
	</div>
</template>
