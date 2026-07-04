<script setup lang="ts">
const { target, isVisible } = useScrollReveal();

const benefits = [
	{ icon: 'eye', title: 'Fully transparent', desc: 'Every line of code is auditable. No black boxes, no hidden behavior.' },
	{ icon: 'git', title: 'Community-driven', desc: 'Report issues, submit PRs, and shape the roadmap alongside other teams.' },
	{ icon: 'server', title: 'Self-hostable', desc: 'Deploy on your own infrastructure. Your data stays where you decide.' },
	{ icon: 'unlock', title: 'No vendor lock-in', desc: 'Fork it, extend it, migrate away. You always own your email stack.' },
];

// Animate the git clone typing effect
const typedText = ref('');
const showCursor = ref(true);
const cloneCommand = 'git clone https://github.com/wolvesdotink/owlat.git';
let typingStarted = false;

watch(isVisible, (visible) => {
	if (visible && !typingStarted) {
		typingStarted = true;
		let i = 0;
		const type = () => {
			if (i <= cloneCommand.length) {
				typedText.value = cloneCommand.slice(0, i);
				i++;
				setTimeout(type, 35 + Math.random() * 25);
			}
		};
		setTimeout(type, 800);
	}
});
</script>

<template>
	<section
		id="open-source"
		ref="target"
		class="py-28 max-md:py-20 border-t border-border-subtle relative overflow-hidden"
		:class="{ visible: isVisible }"
	>
		<div class="max-w-[1200px] mx-auto px-8 max-md:px-6 relative">
			<!-- Header -->
			<div class="text-center mb-16 max-md:mb-12">
				<span class="oss-el font-mono text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-brand mb-5 block" style="--i: 0">
					Open Source
				</span>
				<h2 class="oss-el font-display text-[clamp(2rem,4.5vw,3.25rem)] font-normal leading-[1.1] tracking-[-0.02em] text-text-primary mb-5" style="--i: 1">
					Built in the open,<br class="max-md:hidden">
					<em class="italic">owned</em> by you
				</h2>
				<p class="oss-el text-base text-text-secondary leading-relaxed max-w-[480px] mx-auto" style="--i: 2">
					Owlat is open source software. Inspect every line, self-host on your terms, and contribute to the platform you rely on.
				</p>
			</div>

			<!-- Interactive terminal visual -->
			<div class="oss-el max-w-[520px] mx-auto mb-16 max-md:mb-12" style="--i: 3">
				<div
					class="terminal-window border border-border-default rounded-2xl overflow-hidden transition-all duration-(--motion-moderate)"
					style="background: var(--owlat-code-bg); box-shadow: var(--shadow-card)"
				>
					<div class="flex items-center gap-1.5 px-4 py-3 border-b border-border-default">
						<span class="w-[7px] h-[7px] rounded-full" style="background: color-mix(in oklab, #c46b5a 55%, var(--color-border-strong))" />
						<span class="w-[7px] h-[7px] rounded-full" style="background: color-mix(in oklab, #c9a55a 45%, var(--color-border-strong))" />
						<span class="w-[7px] h-[7px] rounded-full" style="background: color-mix(in oklab, #7a9b6e 45%, var(--color-border-strong))" />
						<span class="ml-auto font-mono text-[0.625rem] font-medium uppercase tracking-[0.06em] text-text-tertiary">terminal</span>
					</div>
					<div class="px-5 py-4 font-mono text-[0.75rem] leading-[1.85]">
						<div class="flex items-center gap-0">
							<span class="text-text-disabled select-none">$ </span>
							<span class="text-text-secondary">{{ typedText }}</span>
							<span class="terminal-cursor" :class="{ typing: typedText.length < cloneCommand.length && typedText.length > 0 }" />
						</div>
						<div class="mt-1.5 h-[1.85em]">
							<Transition name="terminal-line">
								<span v-if="typedText.length === cloneCommand.length" class="text-success">Cloning into 'owlat'...</span>
							</Transition>
						</div>
					</div>
				</div>
			</div>

			<!-- Benefit cards -->
			<div class="grid grid-cols-4 gap-3 max-lg:grid-cols-2 max-md:grid-cols-1">
				<div
					v-for="(benefit, i) in benefits"
					:key="benefit.title"
					class="oss-card group"
					:style="{ '--i': i + 4 }"
				>
					<!-- Icon -->
					<div class="w-9 h-9 rounded-lg flex items-center justify-center mb-4 transition-transform duration-(--motion-moderate) group-hover:scale-105" style="background: var(--color-brand-soft)">
						<!-- Eye -->
						<svg v-if="benefit.icon === 'eye'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-brand">
							<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" />
						</svg>
						<!-- Git branch -->
						<svg v-else-if="benefit.icon === 'git'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-brand">
							<circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><path d="M6 9v12" />
						</svg>
						<!-- Server -->
						<svg v-else-if="benefit.icon === 'server'" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-brand">
							<rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><circle cx="6" cy="6" r="1" fill="currentColor" /><circle cx="6" cy="18" r="1" fill="currentColor" />
						</svg>
						<!-- Unlock -->
						<svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-brand">
							<rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" />
						</svg>
					</div>
					<h3 class="text-[0.9375rem] font-semibold text-text-primary mb-1.5 leading-[1.3] transition-colors duration-(--motion-moderate) group-hover:text-brand">
						{{ benefit.title }}
					</h3>
					<p class="text-[0.8125rem] text-text-secondary leading-[1.65] m-0">
						{{ benefit.desc }}
					</p>
				</div>
			</div>

			<!-- GitHub CTA -->
			<div class="oss-el text-center mt-12" style="--i: 8">
				<a
					href="https://github.com/wolvesdotink/owlat"
					target="_blank"
					rel="noopener noreferrer"
					class="gh-link group inline-flex items-center gap-2.5 px-6 py-3 text-sm font-semibold text-text-primary bg-transparent border border-border-default rounded-xl no-underline transition-all duration-(--motion-moderate) hover:border-brand/40 hover:text-brand hover:bg-brand-soft btn-press relative"
				>
					<!-- GitHub icon -->
					<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" class="transition-transform duration-(--motion-moderate) group-hover:scale-110">
						<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
					</svg>
					<span>View on GitHub</span>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="transition-transform duration-(--motion-moderate) group-hover:translate-x-[2px] group-hover:-translate-y-[2px]">
						<path d="M7 17 17 7" /><path d="M7 7h10v10" />
					</svg>
				</a>
			</div>
		</div>
	</section>
</template>

<style scoped>
/* === Entry animations === */
.oss-el {
	opacity: 0;
	transform: translateY(16px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--i, 0) * 0.07s);
}

.oss-card {
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring),
		background var(--motion-moderate) var(--ease-spring),
		box-shadow var(--motion-moderate) var(--ease-spring);
	transition-delay: calc(0.1s + var(--i, 0) * 0.06s);
	background: var(--surface-2);
	box-shadow: var(--shadow-2);
	border-radius: var(--radius-card);
	padding: 1.5rem;
	position: relative;
	overflow: hidden;
}

.visible .oss-el,
.visible .oss-card {
	opacity: 1;
	transform: none;
}

/* Hover: +6% surface, one elevation step */
.oss-card:hover {
	background: color-mix(in srgb, var(--surface-2) 94%, var(--surface-tint));
	box-shadow: var(--shadow-3);
}

/* === Terminal === */
.terminal-window {
	transition: box-shadow var(--motion-slow) var(--ease-spring), border-color var(--motion-slow) var(--ease-spring);
}

.terminal-window:hover {
	box-shadow: var(--shadow-3);
}

.terminal-cursor {
	display: inline-block;
	width: 7px;
	height: 1.1em;
	background: var(--color-brand);
	margin-left: 1px;
	vertical-align: middle;
	animation: cursor-blink 1s step-end infinite;
}

.terminal-cursor.typing {
	animation: none;
	opacity: 1;
}

@keyframes cursor-blink {
	0%, 100% { opacity: 1; }
	50% { opacity: 0; }
}

/* Terminal line entrance */
.terminal-line-enter-active {
	transition: opacity var(--motion-slow) var(--ease-spring), transform var(--motion-slow) var(--ease-spring);
}

.terminal-line-enter-from {
	opacity: 0;
	transform: translateY(4px);
}

/* === GitHub link glow === */
.gh-link::after {
	content: '';
	position: absolute;
	inset: -1px;
	border-radius: inherit;
	background: var(--color-brand);
	opacity: 0;
	z-index: -1;
	filter: blur(14px);
	transition: opacity var(--motion-slow) var(--ease-spring);
}

.gh-link:hover::after {
	opacity: 0.15;
}
</style>
