<script setup lang="ts">
const visible = ref(false);

onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true;
	});
});

// Copy-paste install command
const installCommand = 'curl -fsSL https://get.owlat.app | bash';
const copied = ref(false);
async function copyInstall() {
	try {
		await navigator.clipboard.writeText(installCommand);
		copied.value = true;
		setTimeout(() => {
			copied.value = false;
		}, 2000);
	} catch {
		// Clipboard unavailable — silently ignore
	}
}
</script>

<template>
	<section class="hero relative border-b border-border-subtle" :class="{ visible }">
		<div
			class="hero-reveal w-full max-w-[1200px] mx-auto px-8 max-md:px-6 py-24 md:py-32 grid grid-cols-[1fr_420px] gap-20 items-center max-lg:grid-cols-1 max-lg:gap-14"
		>
			<!-- Left: Copy -->
			<div>
				<!-- Heading -->
				<h1
					class="text-[clamp(2.5rem,5.5vw,3.75rem)] font-semibold tracking-tight leading-[1.08] text-text-primary"
				>
					Send better emails.
					<span class="block">Build faster.</span>
				</h1>

				<!-- Tagline -->
				<p class="mt-6 text-md text-text-secondary leading-[1.75] max-w-prose">
					Owlat is open-source and self-hosted. Design emails visually, manage audiences, run
					campaigns with A/B testing, and send transactional emails via API — all from one platform.
				</p>

				<!-- Actions: primary CTA + install one-liner -->
				<div class="mt-10 flex items-center gap-3.5 flex-wrap">
					<a
						href="https://docs.owlat.app/developer/self-hosting"
						class="btn btn-primary px-6 text-md no-underline"
					>
						Self-host in 5 minutes
					</a>
					<div
						class="inline-flex items-center gap-3 max-w-[420px] rounded-lg bg-surface-2 border border-border-subtle pl-4 pr-2 py-2 font-mono text-caption"
					>
						<span class="text-text-tertiary shrink-0 select-none" aria-hidden="true">$</span>
						<code
							class="text-text-primary flex-1 overflow-x-auto whitespace-nowrap scrollbar-none"
							>{{ installCommand }}</code
						>
						<button
							type="button"
							class="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-2xs font-semibold uppercase tracking-wider text-text-tertiary hover:text-brand ui-press"
							:aria-label="copied ? 'Copied' : 'Copy install command'"
							@click="copyInstall"
						>
							<svg
								v-if="!copied"
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
								<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
							</svg>
							<svg
								v-else
								width="12"
								height="12"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2.5"
								stroke-linecap="round"
								stroke-linejoin="round"
								class="text-success"
							>
								<path d="M20 6 9 17l-5-5" />
							</svg>
							<span>{{ copied ? 'Copied' : 'Copy' }}</span>
						</button>
					</div>
				</div>

				<p class="text-xs text-text-tertiary mt-4">
					<a
						href="/waitlist"
						class="text-text-tertiary hover:text-brand transition-colors duration-(--motion-fast) underline decoration-dotted underline-offset-[3px]"
					>
						Prefer a managed service? Join the hosted waitlist →
					</a>
				</p>
			</div>

			<!-- Right: Email builder mockup (calm static frame) -->
			<div class="max-lg:flex max-lg:justify-center">
				<div
					class="w-full max-w-[420px] max-md:max-w-full rounded-(--radius-card) overflow-hidden bg-surface-2 border border-border-subtle shadow-(--shadow-2)"
				>
					<!-- Window chrome -->
					<div class="flex items-center gap-2 px-4 py-3.5 border-b border-border-subtle">
						<span class="w-[7px] h-[7px] rounded-full bg-border-strong" />
						<span class="w-[7px] h-[7px] rounded-full bg-border-strong" />
						<span class="w-[7px] h-[7px] rounded-full bg-border-strong" />
						<span
							class="ml-auto font-mono text-2xs font-medium uppercase tracking-[0.06em] text-text-tertiary"
							>Email Builder</span
						>
					</div>
					<!-- Mock email content (static) -->
					<div class="p-5 space-y-3">
						<!-- Header block -->
						<div class="rounded-xl border border-border-subtle p-4 bg-surface-3">
							<div class="flex items-center gap-2 mb-3">
								<div class="w-6 h-6 rounded-full bg-brand/20" />
								<div class="h-2 w-20 rounded-full bg-text-tertiary/20" />
							</div>
							<div class="h-[7px] w-3/4 rounded-full bg-text-tertiary/10 mb-1.5" />
							<div class="h-[7px] w-full rounded-full bg-text-tertiary/8 mb-1.5" />
							<div class="h-[7px] w-2/3 rounded-full bg-text-tertiary/8" />
						</div>
						<!-- Image placeholder -->
						<div
							class="rounded-xl border border-border-subtle h-24 flex items-center justify-center bg-surface-3"
						>
							<svg
								width="28"
								height="28"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.5"
								class="text-text-disabled"
							>
								<rect x="3" y="3" width="18" height="18" rx="2" />
								<circle cx="8.5" cy="8.5" r="1.5" />
								<path d="m21 15-5-5L5 21" />
							</svg>
						</div>
						<!-- Button block -->
						<div class="flex justify-center py-1.5">
							<div class="px-8 py-2.5 rounded-lg text-xs font-semibold bg-brand text-text-inverse">
								Call to Action
							</div>
						</div>
						<!-- Divider -->
						<div class="border-t border-border-subtle" />
						<!-- Social row -->
						<div class="flex justify-center gap-2.5 py-0.5">
							<div v-for="i in 3" :key="i" class="w-6 h-6 rounded-full bg-text-tertiary/12" />
						</div>
					</div>
				</div>
			</div>
		</div>
	</section>
</template>

<style scoped>
/* Single entrance reveal — opacity + small translateY only. The global
 * prefers-reduced-motion floor in packages/ui base.css collapses the
 * transition duration, so this renders instantly for reduced-motion users. */
.hero-reveal {
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
}

.visible .hero-reveal {
	opacity: 1;
	transform: none;
}
</style>
