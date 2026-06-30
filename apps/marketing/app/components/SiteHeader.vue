<script setup lang="ts">
const mobileOpen = ref(false);
const activeSection = ref('');
const scrolled = ref(false);
const bannerDismissed = ref(false);

const navLinks = [
	{ label: 'Features', href: '#features' },
	{ label: 'Developers', href: '#developers' },
	{ label: 'Pricing', href: '#pricing' },
	{ label: 'Docs', href: 'https://docs.owlat.app' },
];

onMounted(() => {
	const sections = ['features', 'developers', 'pricing'];
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					activeSection.value = entry.target.id;
				}
			}
		},
		{ threshold: 0.3 },
	);

	for (const id of sections) {
		const el = document.getElementById(id);
		if (el) observer.observe(el);
	}

	// Track scroll for header styling
	function onScroll() {
		scrolled.value = window.scrollY > 20;
	}
	window.addEventListener('scroll', onScroll, { passive: true });
	onScroll();
});

const headerSurfaceStyle = computed(() => {
	if (scrolled.value) {
		return {
			backdropFilter: 'saturate(160%) blur(16px)',
			WebkitBackdropFilter: 'saturate(160%) blur(16px)',
			backgroundColor: 'color-mix(in oklab, var(--color-bg-base) 80%, transparent)',
		};
	}

	if (bannerDismissed.value) {
		return {
			backgroundColor: 'var(--color-bg-base)',
		};
	}

	return {
		backgroundColor: 'transparent',
	};
});
</script>

<template>
	<!-- Beta announcement bar -->
	<div
		class="beta-bar relative z-[51] overflow-hidden pt-[env(safe-area-inset-top)]"
		:class="{ 'beta-bar--hidden': bannerDismissed }"
	>
		<!-- Animated gradient underlay -->
		<div class="beta-bar-glow" aria-hidden="true" />

		<div class="relative flex items-center justify-center gap-2 max-md:gap-1.5 px-10 max-md:px-8 py-[7px]">
			<span class="beta-dot" aria-hidden="true" />
			<p class="text-[0.75rem] max-md:text-[0.6875rem] font-medium tracking-[0.04em] text-text-primary/80 text-center">
				<span class="max-sm:hidden">Currently in Beta<span class="text-text-tertiary mx-1.5">&mdash;</span></span>
				<span class="sm:hidden">Beta<span class="text-text-tertiary mx-1">&mdash;</span></span>
				<a
					href="https://app.owlat.app/auth/register"
					class="text-brand hover:text-brand-hover transition-colors duration-200 no-underline border-b border-brand/30 hover:border-brand/60 pb-px"
				>
					<span class="max-sm:hidden">Join early and shape the future of email</span>
					<span class="sm:hidden">Join early & shape email's future</span>
				</a>
			</p>
			<button
				class="absolute right-3 max-md:right-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 text-text-disabled hover:text-text-tertiary transition-colors duration-200 bg-transparent border-none cursor-pointer"
				aria-label="Dismiss banner"
				@click="bannerDismissed = true"
			>
				<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
					<path d="M18 6 6 18" /><path d="m6 6 12 12" />
				</svg>
			</button>
		</div>

		<!-- Bottom edge line -->
		<div class="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-brand/20 to-transparent" />
	</div>

	<header
		class="sticky top-0 z-50 border-b transition-all duration-300"
		:class="[
			scrolled
			? 'border-border-subtle/60'
			: 'border-transparent',
			scrolled || bannerDismissed ? 'pt-[env(safe-area-inset-top)]' : '',
		]"
		:style="headerSurfaceStyle"
	>
		<div class="max-w-[1200px] mx-auto px-8 max-md:px-6 h-[60px] flex items-center justify-between">
			<!-- Logo -->
			<a href="/" class="flex items-center gap-2.5 no-underline group">
				<OwlLogo size="28px" />
				<span class="font-display text-lg text-text-primary transition-colors duration-200 group-hover:text-brand">Owlat</span>
			</a>

			<!-- Desktop nav — centered -->
			<nav class="hidden lg:flex items-center gap-9">
				<a
					v-for="link in navLinks"
					:key="link.label"
					:href="link.href"
					class="nav-link relative text-[0.8125rem] font-medium transition-colors duration-200 no-underline py-1"
					:class="activeSection === link.href.replace('#', '')
						? 'text-text-primary'
						: 'text-text-secondary hover:text-text-primary'"
				>
					{{ link.label }}
					<!-- Active section indicator -->
					<span
						class="active-dot absolute -bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-brand transition-all duration-300"
						:class="activeSection === link.href.replace('#', '') ? 'opacity-100 scale-100' : 'opacity-0 scale-0'"
					/>
				</a>
			</nav>

			<!-- Desktop CTAs -->
			<div class="hidden lg:flex items-center gap-4">
				<a
					href="https://app.owlat.app/login"
					class="text-[0.8125rem] font-medium text-text-tertiary hover:text-text-primary transition-colors duration-200 no-underline"
				>
					Sign in
				</a>
				<a
					href="https://app.owlat.app/auth/register"
					class="inline-flex items-center px-5 py-[9px] text-[0.8125rem] font-semibold text-text-inverse bg-brand border border-brand rounded-[10px] no-underline transition-all duration-200 hover:bg-brand-hover hover:border-brand-hover hover:-translate-y-px hover:shadow-brand-hover btn-press"
				>
					Join Waiting List
				</a>
			</div>

			<!-- Mobile hamburger -->
			<button
				class="lg:hidden flex items-center justify-center w-10 h-10 text-text-secondary hover:text-text-primary transition-colors bg-transparent border-none cursor-pointer"
				:aria-label="mobileOpen ? 'Close menu' : 'Open menu'"
				@click="mobileOpen = !mobileOpen"
			>
				<svg v-if="!mobileOpen" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
					<path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" />
				</svg>
				<svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
					<path d="M18 6 6 18" /><path d="m6 6 12 12" />
				</svg>
			</button>
		</div>

		<!-- Mobile drawer -->
		<Transition name="drawer">
			<div
				v-if="mobileOpen"
				class="lg:hidden border-t border-border-subtle px-8 max-md:px-6 py-6 flex flex-col gap-4"
				style="background-color: color-mix(in oklab, var(--color-bg-base) 96%, transparent); backdrop-filter: saturate(160%) blur(16px)"
			>
				<a
					v-for="link in navLinks"
					:key="link.label"
					:href="link.href"
					class="text-base font-medium text-text-secondary hover:text-text-primary transition-colors no-underline py-1"
					@click="mobileOpen = false"
				>
					{{ link.label }}
				</a>
				<div class="flex flex-col gap-3 pt-4 border-t border-border-subtle">
					<a href="https://app.owlat.app/login" class="text-sm font-medium text-text-tertiary hover:text-text-primary transition-colors no-underline text-center py-2">
						Sign in
					</a>
					<a
						href="https://app.owlat.app/auth/register"
						class="inline-flex items-center justify-center px-5 py-2.5 text-sm font-semibold text-text-inverse bg-brand border border-brand rounded-[10px] no-underline transition-all duration-200 hover:bg-brand-hover btn-press"
					>
						Join Waiting List
					</a>
				</div>
			</div>
		</Transition>
	</header>
</template>

<style scoped>
/* Beta announcement bar */
.beta-bar {
	background: linear-gradient(
		90deg,
		color-mix(in oklab, var(--color-brand-subtle) 80%, var(--color-bg-deep)) 0%,
		color-mix(in oklab, var(--color-bg-deep) 70%, var(--color-brand-subtle)) 50%,
		color-mix(in oklab, var(--color-brand-subtle) 80%, var(--color-bg-deep)) 100%
	);
	transition: transform 0.4s var(--ease-out-expo), opacity 0.3s ease, margin-top 0.4s var(--ease-out-expo);
	animation: beta-bar-enter 0.6s var(--ease-out-expo) both;
}

.beta-bar--hidden {
	transform: translateY(-100%);
	opacity: 0;
	margin-top: calc(-34px - env(safe-area-inset-top, 0px));
	pointer-events: none;
}

.beta-bar-glow {
	position: absolute;
	inset: 0;
	background: linear-gradient(
		90deg,
		transparent 0%,
		rgba(196, 120, 90, 0.06) 30%,
		rgba(196, 120, 90, 0.10) 50%,
		rgba(196, 120, 90, 0.06) 70%,
		transparent 100%
	);
	background-size: 200% 100%;
	animation: beta-glow-sweep 8s ease-in-out infinite;
}

.beta-dot {
	width: 5px;
	height: 5px;
	border-radius: 50%;
	background: var(--color-brand);
	box-shadow: 0 0 6px rgba(196, 120, 90, 0.4);
	animation: glow-pulse 3s ease-in-out infinite;
	flex-shrink: 0;
}

@keyframes beta-bar-enter {
	from {
		opacity: 0;
		transform: translateY(-100%);
	}
	to {
		opacity: 1;
		transform: none;
	}
}

@keyframes beta-glow-sweep {
	0%, 100% { background-position: 200% center; }
	50% { background-position: -200% center; }
}

.nav-link::after {
	content: '';
	position: absolute;
	bottom: -2px;
	left: 50%;
	right: 50%;
	height: 1.5px;
	background: var(--color-brand);
	border-radius: 1px;
	transition:
		left 0.3s var(--ease-out-expo),
		right 0.3s var(--ease-out-expo);
}

.nav-link:hover::after {
	left: 0;
	right: 0;
}

.drawer-enter-active,
.drawer-leave-active {
	transition:
		opacity 0.2s ease,
		transform 0.2s var(--ease-out-expo);
}

.drawer-enter-from,
.drawer-leave-to {
	opacity: 0;
	transform: translateY(-6px);
}
</style>
