<script setup lang="ts">
const { t } = useI18n();

useHead({ title: () => t('terms.pageTitle') });

const { public: config } = useRuntimeConfig();
</script>

<template>
	<div class="min-h-screen bg-bg-deep flex flex-col">
		<!-- Navigation -->
		<nav class="flex items-center justify-between px-6 py-4 lg:px-12">
			<NuxtLink to="/" class="font-display text-2xl text-text-primary">Owlat</NuxtLink>
			<UiButton variant="ghost" to="/auth/login">{{ t('terms.signIn') }}</UiButton>
		</nav>

		<!-- Content -->
		<main class="flex-1 px-6 py-12 lg:px-12">
			<article class="mx-auto max-w-3xl prose-legal">
				<h1 class="font-display text-4xl text-text-primary mb-2">{{ t('terms.title') }}</h1>
				<p class="text-text-tertiary text-sm mb-10">{{ t('terms.lastUpdated') }}</p>

				<section class="space-y-6 text-text-secondary leading-relaxed">
					<h2 class="text-xl font-semibold text-text-primary mt-10">
						{{ t('terms.service.heading') }}
					</h2>
					<p>{{ t('terms.service.acceptance') }}</p>
					<p>{{ t('terms.service.scope') }}</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">
						{{ t('terms.account.heading') }}
					</h2>
					<p>{{ t('terms.account.credentials') }}</p>
					<p>{{ t('terms.account.age') }}</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">
						{{ t('terms.billing.heading') }}
					</h2>
					<p>{{ t('terms.billing.fees') }}</p>
					<p>{{ t('terms.billing.priceChanges') }}</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">
						{{ t('terms.acceptableUse.heading') }}
					</h2>
					<p>{{ t('terms.acceptableUse.intro') }}</p>
					<ul class="list-disc pl-6 space-y-2">
						<li>
							<I18nT keypath="terms.acceptableUse.canSpam" tag="span" scope="global">
								<template #law>
									<strong>{{ t('terms.acceptableUse.canSpamLaw') }}</strong>
								</template>
							</I18nT>
						</li>
						<li>
							<I18nT keypath="terms.acceptableUse.gdpr" tag="span" scope="global">
								<template #law>
									<strong>{{ t('terms.acceptableUse.gdprLaw') }}</strong>
								</template>
							</I18nT>
						</li>
						<li>
							<I18nT keypath="terms.acceptableUse.casl" tag="span" scope="global">
								<template #law>
									<strong>{{ t('terms.acceptableUse.caslLaw') }}</strong>
								</template>
							</I18nT>
						</li>
						<li>
							<I18nT keypath="terms.acceptableUse.otherLaws" tag="span" scope="global">
								<template #law>
									<strong>{{ t('terms.acceptableUse.otherLawsLabel') }}</strong>
								</template>
							</I18nT>
						</li>
					</ul>
					<p>{{ t('terms.acceptableUse.monitoring') }}</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">
						{{ t('terms.prohibited.heading') }}
					</h2>
					<p>{{ t('terms.prohibited.intro') }}</p>
					<ul class="list-disc pl-6 space-y-2">
						<li>{{ t('terms.prohibited.purchasedLists') }}</li>
						<li>{{ t('terms.prohibited.spam') }}</li>
						<li>{{ t('terms.prohibited.malware') }}</li>
						<li>{{ t('terms.prohibited.harmfulContent') }}</li>
						<li>{{ t('terms.prohibited.impersonation') }}</li>
						<li>{{ t('terms.prohibited.disruption') }}</li>
						<li>{{ t('terms.prohibited.unauthorizedAccess') }}</li>
						<li>{{ t('terms.prohibited.unlawfulUse') }}</li>
					</ul>
					<p>{{ t('terms.prohibited.consequences') }}</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">
						{{ t('terms.userContent.heading') }}
					</h2>
					<p>{{ t('terms.userContent.ownership') }}</p>
					<p>{{ t('terms.userContent.responsibility') }}</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">
						{{ t('terms.intellectualProperty.heading') }}
					</h2>
					<p>{{ t('terms.intellectualProperty.body') }}</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">
						{{ t('terms.privacy.heading') }}
					</h2>
					<p>{{ t('terms.privacy.policy') }}</p>
					<p>{{ t('terms.privacy.roles') }}</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">
						{{ t('terms.warranties.heading') }}
					</h2>
					<p>{{ t('terms.warranties.body') }}</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">
						{{ t('terms.liability.heading') }}
					</h2>
					<p>{{ t('terms.liability.body') }}</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">
						{{ t('terms.termination.heading') }}
					</h2>
					<p>{{ t('terms.termination.rights') }}</p>
					<p>{{ t('terms.termination.effects') }}</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">
						{{ t('terms.governingLaw.heading') }}
					</h2>
					<p>{{ t('terms.governingLaw.body') }}</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">
						{{ t('terms.amendments.heading') }}
					</h2>
					<p>{{ t('terms.amendments.body') }}</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">
						{{ t('terms.contact.heading') }}
					</h2>
					<p>{{ t('terms.contact.intro') }}</p>
					<p>
						{{ config.companyName }}<br />
						{{ config.companyStreet }}, {{ config.companyPostalCode }} {{ config.companyCity }},
						{{ config.companyCountry }}<br />
						{{ t('terms.contact.emailLabel') }}
						<!-- The legal company details default to empty on a self-host install;
						     an unset address must not leave an empty `mailto:` link in the tab
						     order with no accessible name. -->
						<a
							v-if="config.companyEmail"
							:href="`mailto:${config.companyEmail}`"
							class="text-brand hover:underline"
							>{{ config.companyEmail }}</a
						>
						<span v-else class="text-text-tertiary">{{ t('terms.contact.noEmail') }}</span>
					</p>
				</section>
			</article>
		</main>

		<!-- Footer -->
		<footer class="px-6 py-8 text-center text-text-tertiary text-sm">
			<I18nT keypath="terms.footer.copyright" tag="p" scope="global">
				<template #year>{{ new Date().getFullYear() }}</template>
				<template #company><a href="https://wolves.ink">Wolves</a></template>
			</I18nT>
		</footer>
	</div>
</template>
