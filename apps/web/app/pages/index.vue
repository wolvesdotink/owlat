<script setup lang="ts">
const { t } = useI18n();

// Capability spread mirrors the feature packs an install can turn on
// (README: campaigns, personal mailbox, team inbox, transactional, own MTA).
const capabilities = computed(() => [
	t('home.capabilities.campaigns'),
	t('home.capabilities.automations'),
	t('home.capabilities.transactional'),
	t('home.capabilities.teamInbox'),
	t('home.capabilities.personalMail'),
	t('home.capabilities.ownMta'),
]);

useHead({ title: () => t('home.pageTitle') });
</script>

<template>
	<div class="relative isolate min-h-screen overflow-hidden bg-bg-base flex flex-col">
		<!-- Decorative field — behind the content, ignores the pointer, hidden from AT. -->
		<UiHeroField />

		<!-- Floating pill navigation -->
		<header class="fixed top-4 inset-x-0 z-10 flex justify-center px-4 md:top-6">
			<nav
				class="flex items-center gap-1 rounded-full border border-border-default bg-bg-elevated/85 backdrop-blur-md py-1.5 pr-1.5 pl-5 shadow-surface-2"
				:aria-label="t('home.nav.label')"
			>
				<NuxtLink to="/" class="font-display text-xl text-text-primary pr-4">Owlat</NuxtLink>
				<UiButton variant="ghost" size="sm" to="/auth/login">{{ t('home.nav.logIn') }}</UiButton>
				<UiButton size="sm" to="/auth/register">{{ t('home.nav.getStarted') }}</UiButton>
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
				{{ t('home.hero.eyebrow') }}
			</p>
			<h1 class="lp-title mb-6">
				<span class="block">{{ t('home.hero.title') }}</span>
				<span class="lp-title-accent block">{{ t('home.hero.titleAccent') }}</span>
			</h1>
			<p class="text-lg md:text-xl text-text-secondary mb-10 max-w-2xl">
				{{ t('home.hero.tagline') }}
			</p>
			<div class="flex flex-col sm:flex-row items-center gap-3">
				<UiButton size="lg" to="/auth/register">{{ t('home.hero.getStarted') }}</UiButton>
				<UiButton variant="outline" size="lg" to="/auth/login" class="bg-bg-elevated/60">
					{{ t('home.hero.logIn') }}
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
			<I18nT keypath="home.footer.copyright" tag="p" scope="global">
				<template #year>{{ new Date().getFullYear() }}</template>
				<template #company>
					<a href="https://wolves.ink" class="hover:text-text-secondary">Wolves</a>
				</template>
			</I18nT>
			<p>
				<NuxtLink to="/terms" class="hover:text-text-secondary">{{
					t('home.footer.terms')
				}}</NuxtLink>
				<span class="mx-1">&middot;</span>
				<NuxtLink to="/imprint" class="hover:text-text-secondary">{{
					t('home.footer.imprint')
				}}</NuxtLink>
			</p>
		</footer>
	</div>
</template>
