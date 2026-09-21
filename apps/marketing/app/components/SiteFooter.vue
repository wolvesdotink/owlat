<script setup lang="ts">
const { t, locale, locales } = useI18n();
const switchLocalePath = useSwitchLocalePath();

const footerLinks = {
	product: [
		{ key: 'footer.links.features', href: '#features' },
		{ key: 'footer.links.pricing', href: '#pricing' },
		{ key: 'footer.links.changelog', href: 'https://docs.owlat.app/changelog' },
	],
	developers: [
		{ key: 'footer.links.documentation', href: 'https://docs.owlat.app' },
		{ key: 'footer.links.apiReference', href: 'https://docs.owlat.app/api/' },
		{ key: 'footer.links.sdk', href: 'https://docs.owlat.app/api/sdk' },
	],
	company: [
		{ key: 'footer.links.contact', href: 'mailto:hello@owlat.app' },
		{ key: 'footer.links.builtBy', href: 'https://wolves.ink' },
	],
};

// Driven by the i18n module's own locale list, so adding a locale in
// nuxt.config is the only step needed to make it appear here. This is the site's
// only language switcher.
const languages = computed(() =>
	locales.value.map((entry) => (typeof entry === 'string' ? { code: entry, name: entry } : entry))
);
</script>

<template>
	<footer class="border-t border-border-subtle">
		<div class="max-w-[1200px] mx-auto px-8 max-md:px-6 py-16">
			<div
				class="grid grid-cols-[2fr_1fr_1fr_1fr] gap-12 max-lg:grid-cols-2 max-lg:gap-8 max-sm:grid-cols-1"
			>
				<!-- Brand -->
				<div>
					<div class="flex items-center gap-2.5 mb-4">
						<OwlLogo size="24px" />
						<span class="text-md font-semibold tracking-tight text-text-primary">Owlat</span>
					</div>
					<p class="text-caption text-text-tertiary leading-[1.7] max-w-[240px]">
						{{ t('footer.tagline') }}
					</p>
				</div>

				<!-- Product -->
				<div>
					<h4
						class="font-mono text-2xs font-medium uppercase tracking-[0.1em] text-text-disabled mb-5"
					>
						{{ t('footer.product') }}
					</h4>
					<ul class="space-y-3">
						<li v-for="link in footerLinks.product" :key="link.key">
							<a
								:href="link.href"
								class="text-caption text-text-secondary hover:text-text-primary transition-colors duration-(--motion-fast) no-underline"
							>
								{{ t(link.key) }}
							</a>
						</li>
					</ul>
				</div>

				<!-- Developers -->
				<div>
					<h4
						class="font-mono text-2xs font-medium uppercase tracking-[0.1em] text-text-disabled mb-5"
					>
						{{ t('footer.developers') }}
					</h4>
					<ul class="space-y-3">
						<li v-for="link in footerLinks.developers" :key="link.key">
							<a
								:href="link.href"
								class="text-caption text-text-secondary hover:text-text-primary transition-colors duration-(--motion-fast) no-underline"
							>
								{{ t(link.key) }}
							</a>
						</li>
					</ul>
				</div>

				<!-- Company -->
				<div>
					<h4
						class="font-mono text-2xs font-medium uppercase tracking-[0.1em] text-text-disabled mb-5"
					>
						{{ t('footer.company') }}
					</h4>
					<ul class="space-y-3">
						<li v-for="link in footerLinks.company" :key="link.key">
							<a
								:href="link.href"
								class="text-caption text-text-secondary hover:text-text-primary transition-colors duration-(--motion-fast) no-underline"
							>
								{{ t(link.key) }}
							</a>
						</li>
					</ul>
				</div>
			</div>

			<!-- Meta row -->
			<div
				class="flex items-center justify-between pt-10 mt-12 border-t border-border-subtle max-sm:flex-col max-sm:gap-4"
			>
				<I18nT
					keypath="footer.copyright"
					tag="p"
					class="text-caption text-text-tertiary"
					scope="global"
				>
					<template #year>{{ new Date().getFullYear() }}</template>
					<template #wolves>
						<a
							href="https://wolves.ink"
							class="text-text-tertiary hover:text-text-primary transition-colors duration-(--motion-fast) no-underline"
							>Wolves</a
						>
					</template>
				</I18nT>
				<div class="flex items-center gap-4 max-sm:flex-col max-sm:gap-2">
					<!-- Bordered pill group carried over from the header, which used to
					     hold the only switcher. The visible label is the short code; the
					     endonym ("Deutsch") rides on aria-label so a visitor who cannot
					     read the current language still gets it announced. -->
					<nav
						class="flex items-center gap-0.5 rounded-full border border-border-subtle p-0.5"
						:aria-label="t('language.label')"
					>
						<a
							v-for="lang in languages"
							:key="lang.code"
							:href="switchLocalePath(lang.code)"
							:aria-label="t('language.switchTo', { language: lang.name })"
							:aria-current="lang.code === locale ? 'true' : undefined"
							class="px-2.5 py-1.5 rounded-full font-mono text-2xs font-medium uppercase transition-colors duration-(--motion-fast) no-underline"
							:class="
								lang.code === locale
									? 'bg-bg-soft text-text-primary'
									: 'text-text-tertiary hover:text-text-primary'
							"
						>
							{{ lang.code }}
						</a>
					</nav>
					<p class="font-mono text-2xs font-medium uppercase tracking-[0.1em] text-text-tertiary">
						{{ t('footer.license') }}
					</p>
				</div>
			</div>
		</div>
	</footer>
</template>
