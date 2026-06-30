<script setup lang="ts">
useHead({ title: 'Imprint — Owlat' });

const { public: config } = useRuntimeConfig();
</script>

<template>
	<div class="min-h-screen bg-bg-deep flex flex-col">
		<!-- Navigation -->
		<nav class="flex items-center justify-between px-6 py-4 lg:px-12">
			<NuxtLink to="/" class="font-display text-2xl text-text-primary">Owlat</NuxtLink>
			<NuxtLink to="/auth/login" class="btn btn-ghost">Sign In</NuxtLink>
		</nav>

		<!-- Content -->
		<main class="flex-1 px-6 py-12 lg:px-12">
			<article class="mx-auto max-w-3xl">
				<h1 class="font-display text-4xl text-text-primary mb-10">Impressum</h1>

				<section class="space-y-8 text-text-secondary leading-relaxed">
					<div>
						<h2 class="text-lg font-semibold text-text-primary mb-2">
							Angaben gemäß § 5 TMG
						</h2>
						<p>
							{{ config.companyName }}<br />
							{{ config.companyStreet }}<br />
							{{ config.companyPostalCode }} {{ config.companyCity }}<br />
							{{ config.companyCountry }}
						</p>
					</div>

					<div>
						<h2 class="text-lg font-semibold text-text-primary mb-2">Vertreten durch</h2>
						<p>{{ config.companyRepresentative }} (Geschäftsführer)</p>
					</div>

					<div>
						<h2 class="text-lg font-semibold text-text-primary mb-2">Kontakt</h2>
						<p>
							Telefon: {{ config.companyPhone }}<br />
							E-Mail:
							<a :href="`mailto:${config.companyEmail}`" class="text-brand hover:underline">{{ config.companyEmail }}</a>
						</p>
					</div>

					<div>
						<h2 class="text-lg font-semibold text-text-primary mb-2">
							Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV
						</h2>
						<p>
							{{ config.companyRepresentative }}<br />
							{{ config.companyStreet }}<br />
							{{ config.companyPostalCode }} {{ config.companyCity }}<br />
							{{ config.companyCountry }}
						</p>
					</div>

					<div>
						<h2 class="text-lg font-semibold text-text-primary mb-2">EU-Streitschlichtung</h2>
						<p>
							Die Europäische Kommission stellt eine Plattform zur Online-Streitbeilegung (OS) bereit:
							<a
								href="https://ec.europa.eu/consumers/odr/"
								target="_blank"
								rel="noopener noreferrer"
								class="text-brand hover:underline"
							>
								https://ec.europa.eu/consumers/odr/</a
							>. Unsere E-Mail-Adresse finden Sie oben im Impressum.
						</p>
						<p class="mt-2">
							Wir sind nicht bereit oder verpflichtet, an Streitbeilegungsverfahren vor einer
							Verbraucherschlichtungsstelle teilzunehmen.
						</p>
					</div>
				</section>
			</article>
		</main>

		<!-- Footer -->
		<footer class="px-6 py-8 text-center text-text-tertiary text-sm">
			<p>
				&copy; {{ new Date().getFullYear() }}
				<a href="https://wolves.ink">Wolves</a>. All rights reserved.
			</p>
		</footer>
	</div>
</template>
