<script setup lang="ts">
const { target, isVisible } = useScrollReveal();

const steps = [
	{
		title: 'Install in one command',
		desc: 'One line on a fresh VPS installs the CLI and runs the quickstart: it asks for your domain and settings, brings up the Docker stack, and bootstraps your admin account. About 10 minutes end to end.',
	},
	{
		title: 'Authenticate your domain',
		desc: 'Guided DNS setup for SPF, DKIM, and DMARC. Owlat verifies the records before the domain is allowed to send, and flags DKIM keys due for rotation.',
	},
	{
		title: 'Build and send',
		desc: 'Design emails in the block-based editor, run campaigns with A/B testing and scheduling, wire up trigger-based automations, or send transactional email via the API and SDK.',
	},
	{
		title: 'Measure everything',
		desc: 'Opens, clicks, and engagement are tracked first-party on every transport. Delivery events stream to your systems via webhooks.',
	},
	{
		title: 'Ramp your reputation',
		desc: 'The ramp controller grows your own-MTA sending share step by step, and backs off automatically on bounce, complaint, engagement, or seed-placement signals. No flag day, no manual traffic shifting.',
	},
];
</script>

<template>
	<section
		id="how-it-works"
		ref="target"
		class="px-8 max-md:px-6 py-28 max-md:py-20"
		:class="{ visible: isVisible }"
	>
		<div class="max-w-[1200px] mx-auto">
			<!-- Section header -->
			<div class="mb-16 max-md:mb-12 max-w-[640px]">
				<span class="hiw-el lp-eyebrow mb-4" style="--i: 0">How it works</span>
				<h2 class="hiw-el lp-title mb-4" style="--i: 1">
					From empty VPS to the inbox,
					<span class="lp-title-accent text-brand">measured</span>
				</h2>
				<p
					class="hiw-el text-base text-text-secondary leading-relaxed max-w-[540px]"
					style="--i: 2"
				>
					Five steps from a bare server to email that lands — every one of them observable.
				</p>
			</div>

			<!-- Steps -->
			<ol class="max-w-[720px] list-none m-0 p-0">
				<li
					v-for="(step, i) in steps"
					:key="step.title"
					class="hiw-el relative pl-16 max-md:pl-14 pb-12 last:pb-0"
					:style="{ '--i': i + 3 }"
				>
					<!-- Number -->
					<span
						class="absolute left-0 top-0 font-mono text-caption font-medium text-text-tertiary tabular-nums"
						aria-hidden="true"
					>
						{{ String(i + 1).padStart(2, '0') }}
					</span>
					<!-- Rail -->
					<span
						v-if="i < steps.length - 1"
						class="absolute left-[11px] top-8 bottom-3 w-px bg-border-default"
						aria-hidden="true"
					/>
					<h3 class="text-lg font-medium tracking-[-0.01em] text-text-primary mb-2">
						{{ step.title }}
					</h3>
					<p class="text-md text-text-secondary leading-[1.65] max-w-[540px] m-0">
						{{ step.desc }}
					</p>
				</li>
			</ol>
		</div>
	</section>
</template>

<style scoped>
/* === Entry reveal: opacity + small translateY only === */
.hiw-el {
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
	transition-delay: calc(var(--i, 0) * 0.05s);
}

.visible .hiw-el {
	opacity: 1;
	transform: none;
}
</style>
