<script setup lang="ts">
const { t } = useI18n();

useHead({ title: () => t('imprint.pageTitle') });

const { public: config } = useRuntimeConfig();
</script>

<template>
	<div class="min-h-screen bg-bg-deep flex flex-col">
		<!-- Navigation -->
		<nav class="flex items-center justify-between px-6 py-4 lg:px-12">
			<NuxtLink to="/" class="font-display text-2xl text-text-primary">Owlat</NuxtLink>
			<UiButton variant="ghost" to="/auth/login">{{ t('imprint.signIn') }}</UiButton>
		</nav>

		<!-- Content -->
		<main class="flex-1 px-6 py-12 lg:px-12">
			<article class="mx-auto max-w-3xl">
				<h1 class="font-display text-4xl text-text-primary mb-10">{{ t('imprint.title') }}</h1>

				<section class="space-y-8 text-text-secondary leading-relaxed">
					<div>
						<h2 class="text-lg font-semibold text-text-primary mb-2">
							{{ t('imprint.provider.heading') }}
						</h2>
						<p>
							{{ config.companyName }}<br />
							{{ config.companyStreet }}<br />
							{{ config.companyPostalCode }} {{ config.companyCity }}<br />
							{{ config.companyCountry }}
						</p>
					</div>

					<div>
						<h2 class="text-lg font-semibold text-text-primary mb-2">
							{{ t('imprint.representative.heading') }}
						</h2>
						<p>{{ t('imprint.representative.name', { name: config.companyRepresentative }) }}</p>
					</div>

					<div>
						<h2 class="text-lg font-semibold text-text-primary mb-2">
							{{ t('imprint.contact.heading') }}
						</h2>
						<p>
							{{ t('imprint.contact.phone', { phone: config.companyPhone }) }}<br />
							{{ t('imprint.contact.emailLabel') }}
							<!-- The legal company details default to empty on a self-host install;
							     an unset address must not leave an empty `mailto:` link in the tab
							     order with no accessible name. -->
							<a
								v-if="config.companyEmail"
								:href="`mailto:${config.companyEmail}`"
								class="text-brand hover:underline"
								>{{ config.companyEmail }}</a
							>
							<span v-else class="text-text-tertiary">{{ t('imprint.contact.noEmail') }}</span>
						</p>
					</div>

					<div>
						<h2 class="text-lg font-semibold text-text-primary mb-2">
							{{ t('imprint.responsible.heading') }}
						</h2>
						<p>
							{{ config.companyRepresentative }}<br />
							{{ config.companyStreet }}<br />
							{{ config.companyPostalCode }} {{ config.companyCity }}<br />
							{{ config.companyCountry }}
						</p>
					</div>

					<div>
						<h2 class="text-lg font-semibold text-text-primary mb-2">
							{{ t('imprint.disputeResolution.heading') }}
						</h2>
						<I18nT keypath="imprint.disputeResolution.body" tag="p" scope="global">
							<template #link>
								<a
									href="https://ec.europa.eu/consumers/odr/"
									target="_blank"
									rel="noopener noreferrer"
									class="text-brand hover:underline"
								>
									https://ec.europa.eu/consumers/odr/</a
								>
							</template>
						</I18nT>
						<p class="mt-2">
							{{ t('imprint.disputeResolution.participation') }}
						</p>
					</div>
				</section>
			</article>
		</main>

		<!-- Footer -->
		<footer class="px-6 py-8 text-center text-text-tertiary text-sm">
			<I18nT keypath="imprint.footer.copyright" tag="p" scope="global">
				<template #year>{{ new Date().getFullYear() }}</template>
				<template #company><a href="https://wolves.ink">Wolves</a></template>
			</I18nT>
		</footer>
	</div>
</template>
