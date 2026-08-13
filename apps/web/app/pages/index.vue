<script setup lang="ts">
// Capability spread mirrors the feature packs an install can turn on
// (README: campaigns, personal mailbox, team inbox, transactional, own MTA).
const capabilities = [
	'Campaigns',
	'Automations',
	'Transactional',
	'Team inbox',
	'Personal mail',
	'Own MTA',
];

useHead({
	title: 'Owlat — Self-hosted email platform',
	meta: [
		{
			name: 'description',
			content:
				'Owlat is an open-source, self-hosted email platform: campaigns, automations, transactional sends, team inbox and personal mail, with its own MTA and deliverability tooling.',
		},
	],
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
				class="flex items-center gap-1 rounded-full border border-border-default bg-bg-elevated/85 backdrop-blur-md py-1.5 pr-1.5 pl-5 shadow-surface-2"
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
			<p
				class="mb-8 inline-flex items-center gap-2 rounded-full border border-border-subtle bg-bg-elevated/70 backdrop-blur-sm px-4 py-1.5 text-sm text-text-secondary"
			>
				<span class="w-1.5 h-1.5 rounded-full bg-brand" aria-hidden="true"></span>
				Open source &middot; Self-hosted
			</p>
			<h1 class="text-5xl md:text-6xl lg:text-7xl text-text-primary mb-6">
				<span class="block font-medium tracking-tight">Send better email.</span>
				<span class="block font-display italic font-normal">Own the whole stack.</span>
			</h1>
			<p class="text-lg md:text-xl text-text-secondary mb-10 max-w-2xl">
				Owlat is an open-source, self-hosted email platform. Campaigns, automations, transactional
				sends, a team inbox and personal mail — with its own MTA and deliverability tooling built
				in.
			</p>
			<div class="flex flex-col sm:flex-row items-center gap-3">
				<UiButton size="lg" to="/auth/register">Get started</UiButton>
				<UiButton variant="outline" size="lg" to="/auth/login" class="bg-bg-elevated/60">
					Log in
				</UiButton>
			</div>
			<ul
				class="mt-14 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-sm text-text-tertiary"
			>
				<li
					v-for="(capability, index) in capabilities"
					:key="capability"
					class="flex items-center"
				>
					<span v-if="index > 0" class="mr-3 text-text-disabled" aria-hidden="true">&middot;</span>
					{{ capability }}
				</li>
			</ul>
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
   every color rides a shared token, so the field follows light/dark with the
   rest of the app. */
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
   offset out of the shared breathing keyframe. color-mix carries the alpha so
   the washes can ride the brand/accent tokens instead of fixed rgba. */
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
	background: radial-gradient(
		closest-side,
		color-mix(in srgb, var(--color-brand-glow) 35%, transparent),
		transparent 70%
	);
	animation: landing-breathe 14s ease-in-out infinite;
}

.landing-blob--wing {
	--blob-shift: 4%;
	width: 36rem;
	height: 22rem;
	left: 50%;
	bottom: -12rem;
	background: radial-gradient(
		closest-side,
		color-mix(in srgb, var(--color-accent) 25%, transparent),
		transparent 70%
	);
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
