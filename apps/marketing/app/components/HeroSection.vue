<script setup lang="ts">
const visible = ref(false);

onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true;
	});
});

// Interactive mockup — blocks highlight on hover
const activeBlock = ref(-1);

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
	<section class="hero relative min-h-[100dvh] flex items-center overflow-hidden" :class="{ visible }">
		<!-- Background gradient orbs -->
		<div
			class="absolute pointer-events-none"
			style="top: 8%; left: 8%; width: 520px; height: 520px; border-radius: 50%; background: radial-gradient(circle, rgba(196, 120, 90, 0.07) 0%, transparent 70%); animation: drift 20s ease-in-out infinite"
			aria-hidden="true"
		/>
		<div
			class="absolute pointer-events-none"
			style="top: 50%; right: 5%; width: 400px; height: 400px; border-radius: 50%; background: radial-gradient(circle, rgba(212, 165, 116, 0.04) 0%, transparent 70%); animation: drift-reverse 25s ease-in-out infinite"
			aria-hidden="true"
		/>

		<!-- Scroll progress indicator -->
		<div class="scroll-progress" aria-hidden="true" />

		<!-- Horizontal rule at bottom -->
		<div class="absolute bottom-0 left-0 right-0 h-px bg-border-subtle" />

		<div class="relative w-full max-w-[1200px] mx-auto px-8 max-md:px-6 py-32 max-md:py-20 grid grid-cols-[1fr_420px] gap-20 items-center max-lg:grid-cols-1 max-lg:gap-14">
			<!-- Left: Copy -->
			<div>
				<!-- Badge -->
				<div class="hero-el" style="--delay: 0s">
					<span class="beta-badge inline-flex items-center gap-2.5 text-xs font-medium tracking-[0.12em] uppercase text-brand border border-brand-border rounded-full px-4 py-[6px] bg-brand-soft">
						<span class="w-1.5 h-1.5 rounded-full bg-brand" style="animation: glow-pulse 3s ease-in-out infinite" />
						Open-source · Self-hosted
					</span>
				</div>

				<!-- Logo + Name -->
				<div class="hero-el flex items-center gap-4 mt-10 mb-2" style="--delay: 0.06s">
					<OwlLogo size="56px" />
					<span class="font-display text-[2.5rem] text-text-primary leading-none">Owlat</span>
				</div>

				<!-- Heading -->
				<h1 class="hero-el mt-4 mb-7" style="--delay: 0.12s">
					<span class="font-display text-[clamp(2.8rem,6.5vw,5rem)] leading-[1.06] tracking-[-0.025em] text-text-primary block">
						Send <em class="italic text-shimmer">better</em> emails.
					</span>
					<span class="font-display text-[clamp(2.8rem,6.5vw,5rem)] leading-[1.06] tracking-[-0.025em] text-text-secondary block">
						Build <em class="italic">faster</em>.
					</span>
				</h1>

				<!-- Tagline -->
				<p class="hero-el text-[1.0625rem] text-text-secondary leading-[1.75] max-w-[480px] mb-10" style="--delay: 0.2s">
					Design emails visually, manage audiences, run campaigns with A/B testing, and send transactional emails via API — all from one platform.
				</p>

				<!-- CTAs -->
				<div class="hero-el flex items-center gap-3.5 flex-wrap" style="--delay: 0.28s">
					<a
						href="https://docs.owlat.app/developer/self-hosting"
						class="cta-primary group inline-flex items-center gap-2.5 px-7 py-3 text-[0.9375rem] font-semibold text-text-inverse bg-brand border border-brand rounded-xl no-underline transition-all duration-250 hover:bg-brand-hover hover:border-brand-hover hover:-translate-y-px hover:shadow-brand-hover btn-press"
					>
						<span>Self-host in 5 minutes</span>
						<svg
							class="transition-transform duration-250 group-hover:translate-x-[3px]"
							width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
						>
							<path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
						</svg>
					</a>
					<a
						href="https://docs.owlat.app"
						class="inline-flex items-center px-7 py-3 text-[0.9375rem] font-medium text-text-primary bg-transparent border border-border-default rounded-xl no-underline transition-all duration-250 hover:border-text-tertiary hover:text-brand hover:-translate-y-px btn-press"
					>
						Read the docs
					</a>
				</div>

				<!-- One-liner install -->
				<div class="hero-el mt-8" style="--delay: 0.36s">
					<div
						class="install-box inline-flex items-center gap-3 w-full max-w-[480px] rounded-xl border border-border-default pl-4 pr-2 py-2 font-mono text-[0.8125rem]"
						:style="{ background: 'var(--owlat-code-bg)' }"
					>
						<span class="text-brand shrink-0 select-none">$</span>
						<code class="text-text-primary flex-1 overflow-x-auto whitespace-nowrap scrollbar-none">curl -fsSL https://get.owlat.app | bash</code>
						<button
							type="button"
							class="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[0.6875rem] font-semibold uppercase tracking-wider text-text-tertiary hover:text-brand hover:bg-brand-soft transition-all btn-press"
							:aria-label="copied ? 'Copied' : 'Copy install command'"
							@click="copyInstall"
						>
							<svg v-if="!copied" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
							</svg>
							<svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="text-success">
								<path d="M20 6 9 17l-5-5" />
							</svg>
							<span>{{ copied ? 'Copied' : 'Copy' }}</span>
						</button>
					</div>

					<p class="text-[0.75rem] text-text-tertiary mt-3">
						<a href="/waitlist" class="text-text-tertiary hover:text-brand transition-colors underline decoration-dotted underline-offset-[3px]">
							Prefer a managed service? Join the hosted waitlist →
						</a>
					</p>
				</div>

			</div>

			<!-- Right: Interactive email builder mockup -->
			<div class="hero-visual max-lg:flex max-lg:justify-center">
				<div
					class="mockup-frame w-full max-w-[420px] max-md:max-w-full"
					style="perspective: 800px"
				>
					<div
						class="mockup-inner border border-border-default rounded-2xl overflow-hidden relative"
						style="
							background: var(--owlat-code-bg);
							box-shadow: var(--shadow-card), var(--shadow-glow);
							transform: rotateY(-3deg) rotateX(2deg);
							transition: transform 0.6s var(--ease-out-expo);
						"
					>
						<!-- Shine sweep overlay -->
						<div class="mockup-shine" aria-hidden="true" />

						<!-- Window chrome -->
						<div class="flex items-center gap-2 px-4 py-3.5 border-b border-border-default">
							<span class="w-[7px] h-[7px] rounded-full" style="background: color-mix(in oklab, #c46b5a 55%, var(--color-border-strong))" />
							<span class="w-[7px] h-[7px] rounded-full" style="background: color-mix(in oklab, #c9a55a 45%, var(--color-border-strong))" />
							<span class="w-[7px] h-[7px] rounded-full" style="background: color-mix(in oklab, #7a9b6e 45%, var(--color-border-strong))" />
							<span class="ml-auto font-mono text-[0.6875rem] font-medium uppercase tracking-[0.06em] text-text-tertiary">Email Builder</span>
						</div>
						<!-- Mock email content with hover interactions -->
						<div class="p-5 space-y-3">
							<!-- Header block -->
							<div
								class="mockup-block rounded-xl border p-4 transition-all duration-300 cursor-default"
								:class="activeBlock === 0 ? 'border-brand/40 bg-brand-soft shadow-[0_0_20px_rgba(196,120,90,0.08)]' : 'border-border-subtle'"
								style="background: var(--owlat-bg-soft); --bd: 0"
								@mouseenter="activeBlock = 0"
								@mouseleave="activeBlock = -1"
							>
								<div class="flex items-center gap-2 mb-3">
									<div class="w-6 h-6 rounded-full bg-brand/20 mockup-pulse" />
									<div class="h-2 w-20 rounded-full bg-text-tertiary/20" />
								</div>
								<div class="h-[7px] w-3/4 rounded-full bg-text-tertiary/10 mb-1.5" />
								<div class="h-[7px] w-full rounded-full bg-text-tertiary/8 mb-1.5" />
								<div class="h-[7px] w-2/3 rounded-full bg-text-tertiary/8" />
							</div>
							<!-- Image placeholder -->
							<div
								class="mockup-block rounded-xl border h-24 flex items-center justify-center transition-all duration-300 cursor-default"
								:class="activeBlock === 1 ? 'border-brand/40 shadow-[0_0_20px_rgba(196,120,90,0.08)]' : 'border-border-subtle'"
								style="background: var(--owlat-bg-soft); --bd: 1"
								@mouseenter="activeBlock = 1"
								@mouseleave="activeBlock = -1"
							>
								<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-text-disabled transition-colors duration-300" :class="activeBlock === 1 && 'text-brand/50!'">
									<rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" />
								</svg>
							</div>
							<!-- Button block -->
							<div
								class="mockup-block flex justify-center py-1.5 transition-all duration-300 cursor-default"
								style="--bd: 2"
								@mouseenter="activeBlock = 2"
								@mouseleave="activeBlock = -1"
							>
								<div
									class="px-8 py-2.5 rounded-lg text-xs font-semibold transition-all duration-300"
									:class="activeBlock === 2 ? 'bg-brand-hover text-text-inverse scale-105 shadow-brand-hover' : 'bg-brand text-text-inverse'"
								>
									Call to Action
								</div>
							</div>
							<!-- Divider -->
							<div class="border-t border-border-subtle" />
							<!-- Social row -->
							<div
								class="mockup-block flex justify-center gap-2.5 py-0.5 transition-all duration-300 cursor-default"
								style="--bd: 3"
								@mouseenter="activeBlock = 3"
								@mouseleave="activeBlock = -1"
							>
								<div
									v-for="i in 3" :key="i"
									class="w-6 h-6 rounded-full transition-all duration-300"
									:class="activeBlock === 3 ? 'bg-brand/25 scale-110' : 'bg-text-tertiary/12'"
									:style="{ transitionDelay: activeBlock === 3 ? `${(i - 1) * 50}ms` : '0ms' }"
								/>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</section>
</template>

<style scoped>
/* Staggered entrance via CSS custom property delay */
.hero-el {
	opacity: 0;
	transform: translateY(24px);
	transition:
		opacity 0.7s var(--ease-out-expo),
		transform 0.7s var(--ease-out-expo);
	transition-delay: var(--delay, 0s);
}

.visible .hero-el {
	opacity: 1;
	transform: none;
}

.hero-visual {
	opacity: 0;
	transform: translateY(32px) scale(0.97);
	transition:
		opacity 0.8s var(--ease-out-expo),
		transform 0.8s var(--ease-out-expo);
	transition-delay: 0.2s;
}

.visible .hero-visual {
	opacity: 1;
	transform: none;
}

/* Subtle hover on mockup */
.mockup-frame:hover .mockup-inner {
	transform: rotateY(-1deg) rotateX(1deg) !important;
}

/* Float animation on the mockup */
.visible .mockup-frame {
	animation: float 6s ease-in-out 1.5s infinite;
}

/* Shimmer text effect on "better" */
.text-shimmer {
	background: linear-gradient(
		110deg,
		var(--color-text-primary) 35%,
		var(--color-brand-glow) 50%,
		var(--color-text-primary) 65%
	);
	background-size: 200% 100%;
	-webkit-background-clip: text;
	background-clip: text;
	-webkit-text-fill-color: transparent;
	animation: shimmer-text 4s ease-in-out 2s infinite;
}

@keyframes shimmer-text {
	0%,
	100% {
		background-position: 200% center;
	}
	50% {
		background-position: -200% center;
	}
}

/* Shine sweep on mockup */
.mockup-shine {
	position: absolute;
	inset: 0;
	background: linear-gradient(
		105deg,
		transparent 40%,
		rgba(196, 120, 90, 0.03) 45%,
		rgba(196, 120, 90, 0.06) 50%,
		rgba(196, 120, 90, 0.03) 55%,
		transparent 60%
	);
	background-size: 200% 100%;
	z-index: 1;
	pointer-events: none;
	animation: shine-sweep 6s ease-in-out 3s infinite;
}

@keyframes shine-sweep {
	0%,
	100% {
		background-position: 200% center;
	}
	50% {
		background-position: -200% center;
	}
}

/* Mockup blocks breathe animation */
.mockup-block {
	animation: block-breathe 4s ease-in-out infinite;
	animation-delay: calc(var(--bd, 0) * 0.5s);
}

@keyframes block-breathe {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0.85;
	}
}

/* Mockup avatar pulse */
.mockup-pulse {
	animation: avatar-pulse 3s ease-in-out infinite;
}

@keyframes avatar-pulse {
	0%,
	100% {
		transform: scale(1);
		opacity: 1;
	}
	50% {
		transform: scale(1.1);
		opacity: 0.7;
	}
}

/* CTA button glow pulse on hover */
.cta-primary {
	position: relative;
}

.cta-primary::after {
	content: '';
	position: absolute;
	inset: -1px;
	border-radius: inherit;
	background: var(--color-brand);
	opacity: 0;
	z-index: -1;
	filter: blur(12px);
	transition: opacity 0.3s ease;
}

.cta-primary:hover::after {
	opacity: 0.25;
}

/* Scroll progress bar */
.scroll-progress {
	position: fixed;
	top: 60px;
	left: 0;
	height: 2px;
	background: linear-gradient(90deg, var(--color-brand), var(--color-accent));
	width: 0%;
	z-index: 100;
	animation: scroll-progress linear;
	animation-timeline: scroll();
}

@keyframes scroll-progress {
	to {
		width: 100%;
	}
}
</style>
