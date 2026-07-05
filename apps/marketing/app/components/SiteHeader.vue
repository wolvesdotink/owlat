<script setup lang="ts">
const mobileOpen = ref(false);
const activeSection = ref('');
const scrolled = ref(false);

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

	return {
		backgroundColor: 'var(--color-bg-base)',
	};
});
</script>

<template>
	<header
		class="sticky top-0 z-50 border-b pt-[env(safe-area-inset-top)] transition-all duration-(--motion-moderate)"
		:class="scrolled ? 'border-border-subtle/60' : 'border-transparent'"
		:style="headerSurfaceStyle"
	>
		<div class="max-w-[1200px] mx-auto px-8 max-md:px-6 h-[60px] flex items-center justify-between">
			<!-- Logo -->
			<a href="/" class="flex items-center gap-2.5 no-underline group">
				<OwlLogo size="28px" />
				<span class="font-display text-lg text-text-primary transition-colors duration-(--motion-fast) group-hover:text-brand">Owlat</span>
			</a>

			<!-- Desktop nav — centered -->
			<nav class="hidden lg:flex items-center gap-9">
				<a
					v-for="link in navLinks"
					:key="link.label"
					:href="link.href"
					class="nav-link relative text-[0.8125rem] font-medium transition-colors duration-(--motion-fast) no-underline py-1"
					:class="activeSection === link.href.replace('#', '')
						? 'text-text-primary'
						: 'text-text-secondary hover:text-text-primary'"
				>
					{{ link.label }}
					<!-- Active section indicator -->
					<span
						class="active-dot absolute -bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-brand transition-all duration-(--motion-moderate)"
						:class="activeSection === link.href.replace('#', '') ? 'opacity-100 scale-100' : 'opacity-0 scale-0'"
					/>
				</a>
			</nav>

			<!-- Desktop CTAs -->
			<div class="hidden lg:flex items-center gap-4">
				<a
					href="https://app.owlat.app/login"
					class="text-[0.8125rem] font-medium text-text-tertiary hover:text-text-primary transition-colors duration-(--motion-fast) no-underline"
				>
					Sign in
				</a>
				<a
					href="https://app.owlat.app/auth/register"
					class="inline-flex items-center px-5 py-[9px] text-[0.8125rem] font-semibold text-text-inverse bg-brand border border-brand rounded-[10px] no-underline transition-all duration-(--motion-moderate) hover:bg-brand-hover hover:border-brand-hover hover:shadow-brand-hover btn-press"
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
						class="inline-flex items-center justify-center px-5 py-2.5 text-sm font-semibold text-text-inverse bg-brand border border-brand rounded-[10px] no-underline transition-all duration-(--motion-moderate) hover:bg-brand-hover btn-press"
					>
						Join Waiting List
					</a>
				</div>
			</div>
		</Transition>
	</header>
</template>

<style scoped>
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
		left var(--motion-slow) var(--ease-spring),
		right var(--motion-slow) var(--ease-spring);
}

.nav-link:hover::after {
	left: 0;
	right: 0;
}

.drawer-enter-active,
.drawer-leave-active {
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
}

.drawer-enter-from,
.drawer-leave-to {
	opacity: 0;
	transform: translateY(-6px);
}
</style>
