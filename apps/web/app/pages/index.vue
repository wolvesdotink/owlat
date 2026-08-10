<script setup lang="ts">
useHead({
	title: 'Owlat - Email Marketing Made Simple',
});
</script>

<template>
	<div class="relative isolate min-h-screen overflow-hidden bg-bg-base flex flex-col">
		<!-- Decorative field: hairline grid + soft bottom aurora. Purely ornamental —
		     sits behind the content, ignores the pointer, hidden from AT. -->
		<div class="landing-field" aria-hidden="true">
			<span class="landing-grid"></span>
			<span class="landing-blob landing-blob--core"></span>
			<span class="landing-blob landing-blob--wing"></span>
		</div>

		<!-- Floating pill navigation -->
		<header class="fixed top-4 inset-x-0 z-10 flex justify-center px-4 md:top-6">
			<nav
				class="flex items-center gap-1 rounded-full border border-border-default bg-white/85 backdrop-blur-md py-1.5 pr-1.5 pl-5 shadow-surface-2"
				aria-label="Main"
			>
				<NuxtLink to="/" class="font-display text-xl text-text-primary pr-4">Owlat</NuxtLink>
				<UiButton variant="ghost" size="sm" to="/auth/login">Log in</UiButton>
				<UiButton size="sm" to="/auth/register">Get started</UiButton>
			</nav>
		</header>

		<!-- Hero -->
		<main
			class="relative flex-1 flex flex-col items-center justify-center px-6 pt-32 pb-16 text-center"
		>
			<h1 class="text-5xl md:text-6xl lg:text-7xl text-text-primary mb-6">
				<span class="block font-medium tracking-tight">Email marketing</span>
				<span class="block font-display italic font-normal">made simple</span>
			</h1>
			<p class="text-lg md:text-xl text-text-secondary mb-10 max-w-xl">
				Build beautiful emails, grow your audience, and track what works. Everything you need to
				connect with your customers.
			</p>
			<div class="flex flex-col sm:flex-row items-center gap-3">
				<UiButton size="lg" to="/auth/register"> Get started free </UiButton>
				<UiButton variant="outline" size="lg" to="/auth/login" class="bg-white/60">
					Log in
				</UiButton>
			</div>
		</main>

		<!-- Footer -->
		<footer class="relative px-6 py-8 text-center text-text-tertiary text-sm space-y-2">
			<p>
				&copy; {{ new Date().getFullYear() }}
				<a href="https://wolves.ink" class="hover:text-text-secondary">Wolves</a>. All rights
				reserved.
			</p>
			<p>
				<NuxtLink to="/terms" class="hover:text-text-secondary">Terms of Service</NuxtLink>
				<span class="mx-1">&middot;</span>
				<NuxtLink to="/imprint" class="hover:text-text-secondary">Imprint</NuxtLink>
			</p>
		</footer>
	</div>
</template>

<style scoped>
/* Decorative layer stack. Kept in the SFC so the splash stays self-contained;
   colors ride the shared tokens (hairlines) plus the two fixed aurora washes. */
.landing-field {
	position: absolute;
	inset: 0;
	z-index: -1;
	overflow: hidden;
	pointer-events: none;
}

/* Very subtle 1px grid, masked radially so it only whispers around the hero
   and fades out before it reaches the edges. */
.landing-grid {
	position: absolute;
	inset: 0;
	background-image:
		linear-gradient(to right, var(--color-border-default) 1px, transparent 1px),
		linear-gradient(to bottom, var(--color-border-default) 1px, transparent 1px);
	background-size: 56px 56px;
	opacity: 0.5;
	-webkit-mask-image: radial-gradient(ellipse 85% 70% at 50% 62%, black 0%, transparent 72%);
	mask-image: radial-gradient(ellipse 85% 70% at 50% 62%, black 0%, transparent 72%);
}

/* Bottom aurora: a terracotta core with a warm-gold wing, heavily blurred so
   they read as light, not shapes. --blob-shift keeps each blob's horizontal
   offset out of the shared breathing keyframe. */
.landing-blob {
	position: absolute;
	border-radius: 9999px;
	filter: blur(110px);
	transform: translateX(var(--blob-shift));
	will-change: transform, opacity;
}

.landing-blob--core {
	--blob-shift: -58%;
	width: 44rem;
	height: 26rem;
	left: 50%;
	bottom: -14rem;
	background: radial-gradient(closest-side, rgba(196, 120, 90, 0.35), transparent 70%);
	animation: landing-breathe 14s ease-in-out infinite;
}

.landing-blob--wing {
	--blob-shift: 4%;
	width: 36rem;
	height: 22rem;
	left: 50%;
	bottom: -12rem;
	background: radial-gradient(closest-side, rgba(212, 165, 116, 0.25), transparent 70%);
	animation: landing-breathe 16s ease-in-out infinite;
	animation-delay: -6s;
}

@keyframes landing-breathe {
	0%,
	100% {
		opacity: 0.75;
		transform: translateX(var(--blob-shift)) scale(1);
	}
	50% {
		opacity: 1;
		transform: translateX(var(--blob-shift)) scale(1.08);
	}
}

/* Motion policy: the aurora holds a calm, static frame under reduced motion. */
@media (prefers-reduced-motion: reduce) {
	.landing-blob {
		animation: none;
	}
}
</style>
