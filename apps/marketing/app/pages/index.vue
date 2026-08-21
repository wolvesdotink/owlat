<script setup lang="ts">
const { t } = useI18n();

// Getters, not values: the head is captured once at setup, so a bare `t()` here
// would freeze whichever locale happened to be active when the page mounted.
useSeoMeta({
	title: () => t('seo.home.title'),
	ogTitle: () => t('seo.home.title'),
	description: () => t('seo.home.description'),
	ogDescription: () => t('seo.home.ogDescription'),
	twitterCard: 'summary_large_image',
});

// The OG image is rendered outside the app's i18n context, so the localized
// copy is handed to it as props (one image per locale route).
defineOgImage('Marketing', {
	tagline: t('ogImage.tagline'),
	label: t('ogImage.label'),
});

useSchemaOrg([
	{
		'@type': 'SoftwareApplication',
		name: 'Owlat',
		applicationCategory: 'BusinessApplication',
		operatingSystem: 'Web',
		description: t('seo.home.schemaDescription'),
	},
]);
</script>

<template>
	<div>
		<HeroSection />
		<ProductShowcaseSection />
		<DarkSection>
			<SystemMapSection />
		</DarkSection>
		<FeatureBento />
		<DarkSection>
			<DeveloperSection />
		</DarkSection>
		<OpenSourceSection />
		<PricingSection />
		<DarkSection>
			<CtaSection />
		</DarkSection>
	</div>
</template>
