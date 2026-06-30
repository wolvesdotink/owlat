<script setup lang="ts">
useHead({ title: 'Terms of Service — Owlat' });

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
			<article class="mx-auto max-w-3xl prose-legal">
				<h1 class="font-display text-4xl text-text-primary mb-2">Terms of Service</h1>
				<p class="text-text-tertiary text-sm mb-10">Last updated: March 19, 2026</p>

				<section class="space-y-6 text-text-secondary leading-relaxed">
					<h2 class="text-xl font-semibold text-text-primary mt-10">1. Service Description & Acceptance</h2>
					<p>
						These Terms of Service ("Terms") govern your access to and use of the Owlat email marketing
						platform ("Service") operated by Wolves Software UG (haftungsbeschränkt) ("Company", "we",
						"us"). By creating an account or using the Service, you agree to be bound by these Terms. If you
						do not agree, do not use the Service.
					</p>
					<p>
						Owlat provides tools for creating, managing, and sending email campaigns, managing subscriber
						lists (topics), and analyzing email performance.
					</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">2. Account Registration & Security</h2>
					<p>
						To use the Service, you must create an account with accurate and complete information. You are
						responsible for maintaining the confidentiality of your account credentials and for all
						activities that occur under your account. You must notify us immediately of any unauthorized use.
					</p>
					<p>
						You must be at least 18 years old or the age of legal majority in your jurisdiction to use the
						Service. By registering, you represent that you meet this requirement.
					</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">
						3. Subscriptions, Billing & Refunds
					</h2>
					<p>
						Certain features of the Service require a paid subscription. By subscribing, you agree to pay
						the applicable fees as described at the time of purchase. Subscription fees are billed in advance
						on a recurring basis (monthly or annually) and are non-refundable except where required by
						applicable law.
					</p>
					<p>
						We reserve the right to change pricing with 30 days' notice. Continued use after a price change
						constitutes acceptance of the new pricing.
					</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">
						4. Acceptable Use & Anti-Spam Policy
					</h2>
					<p>
						You agree to comply with all applicable laws when using the Service, including but not limited
						to:
					</p>
					<ul class="list-disc pl-6 space-y-2">
						<li>
							<strong>CAN-SPAM Act (US):</strong> All emails must include a valid physical postal address,
							a clear unsubscribe mechanism, and accurate header and subject line information.
						</li>
						<li>
							<strong>GDPR (EU):</strong> You must obtain valid consent before sending marketing emails to
							EU residents. You must honor data subject rights including access, rectification, and
							erasure.
						</li>
						<li>
							<strong>CASL (Canada):</strong> You must obtain express or implied consent before sending
							commercial electronic messages to Canadian recipients.
						</li>
						<li>
							<strong>Other Laws:</strong> You are responsible for compliance with all other applicable
							anti-spam, privacy, and data protection laws in the jurisdictions where your recipients are
							located.
						</li>
					</ul>
					<p>
						We monitor sending practices and reserve the right to suspend or terminate accounts that exhibit
						high bounce rates, spam complaints, or other indicators of non-compliant sending behavior.
					</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">5. Prohibited Uses</h2>
					<p>You may not use the Service to:</p>
					<ul class="list-disc pl-6 space-y-2">
						<li>Send emails to purchased, rented, or scraped email lists</li>
						<li>
							Send unsolicited bulk email (spam) or emails to recipients who have not given consent
						</li>
						<li>Distribute malware, phishing attempts, or fraudulent content</li>
						<li>Send content that is illegal, harmful, threatening, abusive, or harassing</li>
						<li>Impersonate any person or entity</li>
						<li>Interfere with or disrupt the Service or its infrastructure</li>
						<li>Attempt to gain unauthorized access to any part of the Service</li>
						<li>Use the Service for any purpose that violates applicable laws</li>
					</ul>
					<p>
						Violation of these prohibitions may result in immediate account suspension or termination without
						notice or refund.
					</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">
						6. User Content & Data Ownership
					</h2>
					<p>
						You retain all rights to content you upload, create, or send through the Service ("User
						Content"). By using the Service, you grant us a limited license to process, store, and transmit
						your User Content solely for the purpose of providing the Service.
					</p>
					<p>
						You are solely responsible for your User Content, including ensuring it does not infringe on
						third-party rights.
					</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">7. Intellectual Property</h2>
					<p>
						The Service, including its design, features, and underlying technology, is owned by and
						proprietary to Wolves Software UG. Nothing in these Terms grants you any right to use our
						trademarks, logos, or brand features without prior written consent.
					</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">8. Privacy & Data Processing</h2>
					<p>
						Your use of the Service is also governed by our Privacy Policy. By using the Service, you
						acknowledge that you have read and understood our data processing practices.
					</p>
					<p>
						We process personal data in accordance with the General Data Protection Regulation (GDPR) and
						other applicable data protection laws. Where you use the Service to process personal data of your
						subscribers, you act as the data controller, and we act as the data processor.
					</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">9. Warranties Disclaimer</h2>
					<p>
						THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, WHETHER
						EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS
						FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE
						UNINTERRUPTED, ERROR-FREE, OR SECURE.
					</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">10. Limitation of Liability</h2>
					<p>
						TO THE MAXIMUM EXTENT PERMITTED BY LAW, WOLVES SOFTWARE UG SHALL NOT BE LIABLE FOR ANY INDIRECT,
						INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS OR REVENUES,
						WHETHER INCURRED DIRECTLY OR INDIRECTLY, OR ANY LOSS OF DATA, USE, OR GOODWILL. OUR TOTAL
						LIABILITY SHALL NOT EXCEED THE AMOUNTS PAID BY YOU TO US IN THE TWELVE (12) MONTHS PRECEDING THE
						EVENT GIVING RISE TO THE CLAIM.
					</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">11. Termination</h2>
					<p>
						You may terminate your account at any time through the Service settings. We may suspend or
						terminate your access at any time for violation of these Terms or for any other reason at our
						discretion with reasonable notice, except in cases of severe violations where immediate action is
						necessary.
					</p>
					<p>
						Upon termination, your right to use the Service ceases immediately. We may retain your data for
						a reasonable period as required by law or legitimate business purposes.
					</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">12. Governing Law & Jurisdiction</h2>
					<p>
						These Terms are governed by and construed in accordance with the laws of the Federal Republic of
						Germany. The exclusive place of jurisdiction for all disputes arising from or in connection with
						these Terms is Berlin, Germany, to the extent permitted by law.
					</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">13. Amendments & Changes</h2>
					<p>
						We reserve the right to modify these Terms at any time. We will notify you of material changes by
						email or through the Service at least 30 days before they take effect. Your continued use of the
						Service after changes become effective constitutes acceptance of the revised Terms.
					</p>

					<h2 class="text-xl font-semibold text-text-primary mt-10">14. Contact</h2>
					<p>If you have questions about these Terms, please contact us at:</p>
					<p>
						{{ config.companyName }}<br />
						{{ config.companyStreet }}, {{ config.companyPostalCode }} {{ config.companyCity }}, {{ config.companyCountry }}<br />
						Email:
						<a :href="`mailto:${config.companyEmail}`" class="text-brand hover:underline">{{ config.companyEmail }}</a>
					</p>
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
