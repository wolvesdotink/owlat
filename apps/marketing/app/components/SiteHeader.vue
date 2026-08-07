<script setup lang="ts">
const mobileOpen = ref(false);
const activeSection = ref('');

const { platformLabel, downloadAriaLabel, onDownloadClick } = useDesktopDownload();

const navLinks = [
	{ label: 'Features', href: '#features' },
	{ label: 'Developers', href: '#developers' },
	{ label: 'Pricing', href: '#pricing' },
	{ label: 'Docs', href: 'https://docs.owlat.app' },
	{ label: 'GitHub', href: 'https://github.com/wolvesdotink/owlat' },
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
		{ threshold: 0.3 }
	);

	for (const id of sections) {
		const el = document.getElementById(id);
		if (el) observer.observe(el);
	}
});
</script>

<template>
	<header
		class="fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.875rem)] z-(--z-header) px-4 pointer-events-none"
	>
		<div class="pointer-events-auto mx-auto w-fit max-lg:w-full max-lg:max-w-[480px]">
			<!-- Floating pill -->
			<div
				class="nav-pill flex items-center gap-1 rounded-full pl-4 pr-1.5 py-1.5 max-lg:justify-between"
			>
				<!-- Logo -->
				<a href="/" class="flex items-center gap-2 no-underline pr-1">
					<OwlLogo size="22px" />
					<span class="text-md font-semibold tracking-tight text-text-primary">Owlat</span>
				</a>

				<!-- Desktop nav -->
				<nav class="hidden lg:flex items-center px-2">
					<a
						v-for="link in navLinks"
						:key="link.label"
						:href="link.href"
						class="px-3 py-1.5 text-caption font-medium rounded-full transition-colors duration-(--motion-fast) no-underline"
						:class="
							activeSection === link.href.replace('#', '')
								? 'text-text-primary'
								: 'text-text-secondary hover:text-text-primary'
						"
					>
						{{ link.label }}
					</a>
				</nav>

				<!-- Desktop CTAs -->
				<div class="hidden lg:flex items-center gap-2">
					<a
						href="https://app.owlat.app/login"
						class="px-3 py-1.5 text-caption font-medium text-text-secondary hover:text-text-primary transition-colors duration-(--motion-fast) no-underline"
					>
						Sign in
					</a>
					<a
						href="https://github.com/wolvesdotink/owlat/releases"
						class="btn btn-hairline px-4 py-2 text-caption no-underline"
						:aria-label="downloadAriaLabel"
						title="All platforms on the releases page"
						@click="onDownloadClick"
					>
						Download
					</a>
					<a href="/waitlist" class="btn btn-primary px-4 py-2 text-caption no-underline">
						Join waitlist
					</a>
				</div>

				<!-- Mobile hamburger -->
				<button
					class="lg:hidden flex items-center justify-center w-9 h-9 rounded-full text-text-secondary hover:text-text-primary transition-colors duration-(--motion-fast) bg-transparent border-none cursor-pointer"
					:aria-label="mobileOpen ? 'Close menu' : 'Open menu'"
					:aria-expanded="mobileOpen"
					@click="mobileOpen = !mobileOpen"
				>
					<svg
						v-if="!mobileOpen"
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						aria-hidden="true"
					>
						<path d="M4 8h16" />
						<path d="M4 16h16" />
					</svg>
					<svg
						v-else
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						aria-hidden="true"
					>
						<path d="M18 6 6 18" />
						<path d="m6 6 12 12" />
					</svg>
				</button>
			</div>

			<!-- Mobile dropdown panel -->
			<Transition name="drawer">
				<div v-if="mobileOpen" class="lg:hidden nav-panel mt-2 rounded-3xl p-3">
					<nav class="flex flex-col">
						<a
							v-for="link in navLinks"
							:key="link.label"
							:href="link.href"
							class="px-3.5 py-2.5 text-md font-medium text-text-secondary hover:text-text-primary rounded-xl transition-colors duration-(--motion-fast) no-underline"
							@click="mobileOpen = false"
						>
							{{ link.label }}
						</a>
					</nav>
					<div class="flex flex-col gap-2 pt-3 mt-2 border-t border-border-subtle">
						<a
							href="https://app.owlat.app/login"
							class="text-caption font-medium text-text-secondary hover:text-text-primary transition-colors duration-(--motion-fast) no-underline text-center py-2"
						>
							Sign in
						</a>
						<a
							href="https://github.com/wolvesdotink/owlat/releases"
							class="btn btn-hairline w-full no-underline"
							:aria-label="downloadAriaLabel"
							@click="onDownloadClick"
						>
							{{ platformLabel ? `Download for ${platformLabel}` : 'Download' }}
						</a>
						<a
							href="https://github.com/wolvesdotink/owlat/releases"
							target="_blank"
							rel="noopener noreferrer"
							class="text-2xs font-medium text-text-tertiary hover:text-text-primary transition-colors duration-(--motion-fast) no-underline text-center py-1"
						>
							All platforms
						</a>
						<a href="/waitlist" class="btn btn-primary w-full no-underline"> Join waitlist </a>
					</div>
				</div>
			</Transition>
		</div>
	</header>
</template>

<style scoped>
.nav-pill {
	background-color: color-mix(in srgb, var(--surface-3) 85%, transparent);
	backdrop-filter: saturate(160%) blur(16px);
	-webkit-backdrop-filter: saturate(160%) blur(16px);
	border: 1px solid var(--color-border-subtle);
	box-shadow: var(--shadow-2);
}

.nav-panel {
	background-color: color-mix(in srgb, var(--surface-3) 96%, transparent);
	backdrop-filter: saturate(160%) blur(16px);
	-webkit-backdrop-filter: saturate(160%) blur(16px);
	border: 1px solid var(--color-border-subtle);
	box-shadow: var(--shadow-4);
}

.drawer-enter-active,
.drawer-leave-active {
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
}

.drawer-enter-from,
.drawer-leave-to {
	opacity: 0;
	transform: translateY(-6px);
}

@media (prefers-reduced-motion: reduce) {
	.drawer-enter-active,
	.drawer-leave-active {
		transition: none;
	}
}
</style>
