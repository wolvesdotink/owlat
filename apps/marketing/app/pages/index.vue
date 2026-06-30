<script setup lang="ts">
useSeoMeta({
	title: 'Owlat — Email Infrastructure for Product Teams',
	ogTitle: 'Owlat — Email Infrastructure for Product Teams',
	description: 'Campaigns, automations, transactional sends, and audience operations from one platform. Backed by Convex and powered by AWS SES.',
	ogDescription: 'Open-source email infrastructure for product teams. Send campaigns, automate flows, and manage audiences — all from one platform.',
	twitterCard: 'summary_large_image',
})

defineOgImage('Marketing', {})

useSchemaOrg([
	{
		'@type': 'SoftwareApplication',
		'name': 'Owlat',
		'applicationCategory': 'BusinessApplication',
		'operatingSystem': 'Web',
		'description': 'Email infrastructure for product teams. Campaigns, automations, transactional sends, and audience operations from one platform.',
	},
])
</script>

<template>
	<div>
		<HeroSection />
		<TrustBar />
		<FeatureBento />
		<OpenSourceSection />
		<DeveloperSection />
		<PricingSection />
		<CtaSection />
	</div>
</template>
