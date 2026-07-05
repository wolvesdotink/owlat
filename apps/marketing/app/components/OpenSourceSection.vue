<script setup lang="ts">
const { target, isVisible } = useScrollReveal();

const links = [
	{
		href: 'https://github.com/wolvesdotink/owlat',
		external: true,
		icon: 'github',
		title: 'View on GitHub',
		desc: 'Every line of code is auditable. Report issues, submit PRs, and shape the roadmap.',
	},
	{
		href: 'https://docs.owlat.app/developer/self-hosting',
		external: false,
		icon: 'server',
		title: 'Self-hosting guide',
		desc: 'Deploy on your own infrastructure. Your data stays where you decide — no vendor lock-in.',
	},
];
</script>

<template>
	<section
		id="open-source"
		ref="target"
		class="px-8 max-md:px-6 py-28 max-md:py-20 border-t border-border-subtle"
		:class="{ visible: isVisible }"
	>
		<div class="max-w-[1200px] mx-auto">
			<!-- Section header -->
			<div class="mb-16 max-md:mb-12">
				<span
					class="oss-el text-xs font-medium uppercase tracking-widest text-text-tertiary mb-4 block"
					style="--i: 0"
				>
					Open Source
				</span>
				<h2
					class="oss-el text-[clamp(2rem,4.5vw,3.25rem)] font-semibold leading-[1.1] tracking-tight text-text-primary mb-4"
					style="--i: 1"
				>
					Built in the open,<br class="max-md:hidden" />
					owned by you
				</h2>
				<p class="oss-el text-base text-text-secondary leading-relaxed max-w-prose" style="--i: 2">
					Owlat is open source software. Inspect every line, self-host on your terms, and contribute
					to the platform you rely on. Fork it, extend it, migrate away — you always own your email
					stack.
				</p>
			</div>

			<!-- Repo + self-hosting links -->
			<div class="grid grid-cols-2 gap-3 max-md:grid-cols-1">
				<a
					v-for="link in links"
					:key="link.title"
					:href="link.href"
					:target="link.external ? '_blank' : undefined"
					:rel="link.external ? 'noopener noreferrer' : undefined"
					class="oss-card no-underline"
				>
					<div class="flex items-start gap-3.5">
						<!-- GitHub -->
						<svg
							v-if="link.icon === 'github'"
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="currentColor"
							class="shrink-0 mt-0.5 text-text-tertiary"
							aria-hidden="true"
						>
							<path
								d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"
							/>
						</svg>
						<!-- Server -->
						<svg
							v-else
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
							stroke-linejoin="round"
							class="shrink-0 mt-0.5 text-text-tertiary"
							aria-hidden="true"
						>
							<rect x="2" y="2" width="20" height="8" rx="2" />
							<rect x="2" y="14" width="20" height="8" rx="2" />
							<circle cx="6" cy="6" r="1" fill="currentColor" />
							<circle cx="6" cy="18" r="1" fill="currentColor" />
						</svg>
						<div class="min-w-0">
							<span
								class="flex items-center gap-1.5 text-[0.9375rem] font-[550] text-text-primary leading-[1.3] mb-1.5"
							>
								{{ link.title }}
								<svg
									width="13"
									height="13"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									class="text-text-tertiary"
									aria-hidden="true"
								>
									<path d="M7 17 17 7" />
									<path d="M7 7h10v10" />
								</svg>
							</span>
							<span class="block text-[0.8125rem] text-text-secondary leading-[1.65]">
								{{ link.desc }}
							</span>
						</div>
					</div>
				</a>
			</div>
		</div>
	</section>
</template>

<style scoped>
/* === Entry reveal: opacity + small translateY only === */
.oss-el {
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
	transition-delay: calc(var(--i, 0) * 0.05s);
}

.oss-card {
	opacity: 0;
	transform: translateY(8px);
	background: var(--surface-2);
	border: 1px solid var(--color-border-subtle);
	border-radius: var(--radius-card);
	box-shadow: var(--shadow-2);
	padding: 1.75rem;
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring),
		background var(--motion-fast) var(--ease-spring),
		box-shadow var(--motion-fast) var(--ease-spring);
}

.visible .oss-el,
.visible .oss-card {
	opacity: 1;
	transform: none;
}

/* Hover: one surface step, one elevation step */
.oss-card:hover {
	background: var(--surface-2-hover);
	box-shadow: var(--shadow-3);
}
</style>
