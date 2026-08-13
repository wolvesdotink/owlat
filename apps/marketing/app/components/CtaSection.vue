<script setup lang="ts">
// Final CTA — renders inside <DarkSection>, where btn-primary resolves to a
// white pill and the text scales flip to white.
const { target, isVisible } = useScrollReveal();

const { platformLabel, downloadAriaLabel, onDownloadClick } = useDesktopDownload();

// Grounded in README: "Open-source (Apache 2.0) · Free to self-host ·
// no per-contact pricing · 10 minutes from empty VPS to working install."
// The alpha caveat lives on the hero caption, where a visitor first meets the
// download CTA, rather than being repeated here.
const trustItems = [
	'Apache 2.0',
	'Free to self-host',
	'No per-contact pricing',
	'10-minute install',
];
</script>

<template>
	<div
		ref="target"
		class="px-12 max-md:px-6 py-28 max-md:py-20 text-center"
		:class="{ visible: isVisible }"
	>
		<div class="max-w-[640px] mx-auto">
			<h2 class="cta-el lp-title mb-5" style="--i: 0">
				Start sending <span class="lp-title-accent">better</span> email
			</h2>

			<p
				class="cta-el text-base text-text-secondary leading-relaxed max-w-[440px] mx-auto mb-10"
				style="--i: 1"
			>
				Every feature is included from the start — no feature gates, no plan upgrades.
			</p>

			<div class="cta-el flex items-center justify-center gap-3 flex-wrap" style="--i: 2">
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
					href="https://github.com/wolvesdotink/owlat"
					target="_blank"
					rel="noopener noreferrer"
					class="btn btn-hairline group px-6 no-underline"
				>
					<span>View on GitHub</span>
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

			<!-- Trust row -->
			<p
				class="cta-el mt-10 flex items-center justify-center gap-2.5 flex-wrap text-caption text-text-tertiary"
				style="--i: 3"
			>
				<template v-for="(item, i) in trustItems" :key="item">
					<span>{{ item }}</span>
					<span v-if="i < trustItems.length - 1" aria-hidden="true" class="text-text-disabled"
						>·</span
					>
				</template>
			</p>
		</div>
	</div>
</template>

<style scoped>
/* === Entry reveal: opacity + small translateY only === */
.cta-el {
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
	transition-delay: calc(var(--i, 0) * 0.05s);
}

.visible .cta-el {
	opacity: 1;
	transform: none;
}
</style>
