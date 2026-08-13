<script setup lang="ts">
// Standards Owlat implements: SMTP/DKIM/SPF/DMARC/IMAP (README),
// ARC (packages/mail-auth), MTA-STS / TLS-RPT / DANE (packages/shared,
// packages/smtp-client).
const standards = ['SMTP', 'DKIM', 'SPF', 'DMARC', 'ARC', 'MTA-STS', 'TLS-RPT', 'DANE', 'IMAP'];

const { platformLabel, downloadAriaLabel, onDownloadClick } = useDesktopDownload();
</script>

<template>
	<section class="relative min-h-[100dvh] flex items-center justify-center overflow-hidden">
		<!-- Background layers -->
		<div class="absolute inset-0 hero-grid" aria-hidden="true" />
		<div class="absolute inset-0 hero-grain" aria-hidden="true" />
		<div class="absolute inset-0 overflow-hidden" aria-hidden="true">
			<div class="lp-aurora lp-aurora-gold" />
			<div class="lp-aurora lp-aurora-rose" />
			<div class="lp-aurora lp-aurora-core" />
		</div>
		<div
			class="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-bg-base to-transparent"
			aria-hidden="true"
		/>
		<div
			class="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-bg-base to-transparent"
			aria-hidden="true"
		/>

		<!-- Content -->
		<div
			class="relative w-full max-w-[880px] mx-auto px-8 max-md:px-6 pt-36 pb-24 flex flex-col items-center text-center"
		>
			<!-- Announcement chip — README: "Hosted cloud is on the roadmap — join the waitlist." -->
			<a
				href="/waitlist"
				class="lp-hero-in group inline-flex items-center gap-2 rounded-full border border-border-subtle bg-surface-3/70 backdrop-blur-sm px-4 py-2 text-caption text-text-secondary no-underline transition-colors duration-(--motion-fast) hover:border-border-default hover:text-text-primary"
				style="--i: 0"
			>
				<span class="w-1.5 h-1.5 rounded-full bg-brand" aria-hidden="true" />
				<span>Hosted Cloud coming soon</span>
				<span class="text-text-disabled" aria-hidden="true">·</span>
				<span class="inline-flex items-center gap-1 font-medium text-text-primary">
					Join the waitlist
					<svg
						class="transition-transform duration-(--motion-fast) group-hover:translate-x-[2px]"
						width="12"
						height="12"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M5 12h14" />
						<path d="m12 5 7 7-7 7" />
					</svg>
				</span>
			</a>

			<!-- Headline -->
			<h1
				class="lp-hero-in mt-9 text-[clamp(2.75rem,6.5vw,4.75rem)] font-medium tracking-[-0.02em] leading-[1.04] text-text-primary"
				style="--i: 1"
			>
				Send better email.
				<span class="block lp-title-accent lp-warm-gradient pb-1">Own the whole stack.</span>
			</h1>

			<!-- Sub -->
			<p
				class="lp-hero-in mt-6 text-md md:text-lg text-text-secondary leading-[1.65] max-w-[540px]"
				style="--i: 2"
			>
				Owlat is an open-source, self-hosted email platform. Campaigns, automations, transactional
				sends, and audience ops — with its own MTA and deliverability tooling built in.
			</p>

			<!-- CTAs -->
			<div class="lp-hero-in mt-10 flex items-center justify-center gap-3 flex-wrap" style="--i: 3">
				<a
					href="https://github.com/wolvesdotink/owlat/releases"
					class="btn btn-primary group px-6 no-underline"
					:aria-label="downloadAriaLabel"
					@click="onDownloadClick"
				>
					<span>{{ platformLabel ? `Download for ${platformLabel}` : 'Download the app' }}</span>
					<svg
						class="transition-transform duration-(--motion-fast) group-hover:translate-y-[2px]"
						width="15"
						height="15"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
						<path d="m7 10 5 5 5-5" />
						<path d="M12 15V3" />
					</svg>
				</a>
				<a
					href="https://docs.owlat.app/developer/self-hosting"
					class="btn btn-hairline group px-6 no-underline"
				>
					<span>Self-host</span>
					<svg
						class="transition-transform duration-(--motion-fast) group-hover:translate-x-[3px]"
						width="15"
						height="15"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2.5"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M5 12h14" />
						<path d="m12 5 7 7-7 7" />
					</svg>
				</a>
			</div>

			<!-- Maturity note under the download CTA — README: Owlat, the desktop app included, is in alpha. -->
			<p class="lp-hero-in mt-5 text-caption text-text-tertiary" style="--i: 4">
				Desktop app for macOS, Windows and Linux — in alpha, like the rest of Owlat.
			</p>

			<!-- Standards ticker -->
			<div class="lp-hero-in mt-14 w-full max-w-[620px]" style="--i: 5">
				<p
					class="font-mono text-2xs font-medium uppercase tracking-[0.18em] text-text-tertiary mb-5"
				>
					Built on open standards
				</p>
				<div class="lp-marquee">
					<div class="lp-marquee-track">
						<div class="lp-marquee-half">
							<span
								v-for="std in standards"
								:key="std"
								class="font-mono text-caption font-medium text-text-primary/50 whitespace-nowrap"
							>
								{{ std }}
							</span>
						</div>
						<div class="lp-marquee-half" aria-hidden="true">
							<span
								v-for="std in standards"
								:key="std"
								class="font-mono text-caption font-medium text-text-primary/50 whitespace-nowrap"
							>
								{{ std }}
							</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	</section>
</template>
