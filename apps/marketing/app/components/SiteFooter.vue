<script setup lang="ts">
const footerLinks = {
	product: [
		{ label: 'Features', href: '#features' },
		{ label: 'Pricing', href: '#pricing' },
		{ label: 'Changelog', href: 'https://docs.owlat.app/changelog' },
	],
	developers: [
		{ label: 'Documentation', href: 'https://docs.owlat.app' },
		{ label: 'API Reference', href: 'https://docs.owlat.app/api/' },
		{ label: 'SDK', href: 'https://docs.owlat.app/api/sdk' },
	],
	company: [
		{ label: 'Contact', href: 'mailto:hello@owlat.app' },
		{ label: 'Built by Wolves', href: 'https://wolves.ink' },
	],
};
</script>

<template>
	<footer class="border-t border-border-subtle" style="background: var(--color-bg-deep)">
		<div class="max-w-[1200px] mx-auto px-8 max-md:px-6 py-16">
			<div class="grid grid-cols-[2fr_1fr_1fr_1fr] gap-12 max-lg:grid-cols-2 max-lg:gap-8 max-sm:grid-cols-1">
				<!-- Brand -->
				<div>
					<div class="flex items-center gap-2.5 mb-4">
						<OwlLogo size="24px" />
						<span class="font-display text-lg text-text-primary">Owlat</span>
					</div>
					<p class="text-[0.8125rem] text-text-tertiary leading-[1.7] max-w-[240px]">
						Email infrastructure for product teams. Campaigns, automations, and transactional sends from one platform.
					</p>
				</div>

				<!-- Product -->
				<div>
					<h4 class="font-mono text-[0.625rem] font-medium uppercase tracking-[0.1em] text-text-disabled mb-5">Product</h4>
					<ul class="space-y-3">
						<li v-for="link in footerLinks.product" :key="link.label">
							<a :href="link.href" class="footer-link text-[0.8125rem] text-text-tertiary hover:text-text-primary transition-colors duration-200 no-underline relative">
								{{ link.label }}
							</a>
						</li>
					</ul>
				</div>

				<!-- Developers -->
				<div>
					<h4 class="font-mono text-[0.625rem] font-medium uppercase tracking-[0.1em] text-text-disabled mb-5">Developers</h4>
					<ul class="space-y-3">
						<li v-for="link in footerLinks.developers" :key="link.label">
							<a :href="link.href" class="footer-link text-[0.8125rem] text-text-tertiary hover:text-text-primary transition-colors duration-200 no-underline relative">
								{{ link.label }}
							</a>
						</li>
					</ul>
				</div>

				<!-- Company -->
				<div>
					<h4 class="font-mono text-[0.625rem] font-medium uppercase tracking-[0.1em] text-text-disabled mb-5">Company</h4>
					<ul class="space-y-3">
						<li v-for="link in footerLinks.company" :key="link.label">
							<a :href="link.href" class="footer-link text-[0.8125rem] text-text-tertiary hover:text-text-primary transition-colors duration-200 no-underline relative">
								{{ link.label }}
							</a>
						</li>
					</ul>
				</div>
			</div>

			<!-- Bottom bar -->
			<div class="flex items-center justify-between pt-10 mt-12 border-t border-border-subtle max-sm:flex-col max-sm:gap-4">
				<p class="text-[0.6875rem] text-text-disabled">&copy; {{ new Date().getFullYear() }} <a href="https://wolves.ink">Wolves</a>. All rights reserved.</p>
				<UiThemeToggle
					class="theme-toggle flex items-center gap-2 text-[0.6875rem] text-text-disabled hover:text-text-tertiary transition-all duration-300 cursor-pointer bg-transparent border-none p-0"
				>
					<span>Theme</span>
				</UiThemeToggle>
			</div>
		</div>
	</footer>
</template>

<style scoped>
/* Footer link hover underline animation */
.footer-link::after {
	content: '';
	position: absolute;
	bottom: -2px;
	left: 0;
	width: 0;
	height: 1px;
	background: var(--color-text-tertiary);
	transition: width 0.3s var(--ease-out-expo);
}

.footer-link:hover::after {
	width: 100%;
}
</style>
