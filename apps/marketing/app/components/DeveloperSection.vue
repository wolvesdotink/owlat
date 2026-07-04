<script setup lang="ts">
const { target, isVisible } = useScrollReveal();
const activeTab = ref<'sdk' | 'curl'>('sdk');
const copied = ref(false);

const codeSnippets = {
	sdk: `import { Owlat } from '@owlat/sdk-js'

const owlat = new Owlat('lm_live_...')

// Send a transactional email
await owlat.transactional.send({
  email: 'mira@acme.io',
  slug:  'welcome-email',
  dataVariables: { firstName: 'Mira' }
})

// Create a contact and add to a list
const contact = await owlat.contacts.create({
  email: 'mira@acme.io',
  firstName: 'Mira'
})

await owlat.lists.addContact({
  listId: 'list_abc123',
  email:  'mira@acme.io'
})`,
	curl: `# Send a transactional email
curl -X POST https://your-deployment.convex.site/api/v1/transactional \\
  -H "Authorization: Bearer lm_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "slug": "welcome-email",
    "email": "mira@acme.io",
    "dataVariables": {
      "firstName": "Mira"
    }
  }'`,
};

async function copyCode() {
	try {
		await navigator.clipboard.writeText(codeSnippets[activeTab.value]);
		copied.value = true;
		setTimeout(() => { copied.value = false; }, 2000);
	} catch {}
}

const capabilities = [
	{ icon: 'send', label: 'Transactional sends' },
	{ icon: 'users', label: 'Contact management' },
	{ icon: 'zap', label: 'Automation triggers' },
	{ icon: 'bar', label: 'Delivery tracking' },
];
</script>

<template>
	<section
		id="developers"
		ref="target"
		class="py-28 max-md:py-20 border-t border-border-subtle"
		:class="{ visible: isVisible }"
		style="background: linear-gradient(180deg, var(--color-bg-elevated) 0%, var(--color-bg-base) 100%)"
	>
		<div class="max-w-[1200px] mx-auto px-8 max-md:px-6 grid grid-cols-[5fr_7fr] gap-20 items-center max-lg:grid-cols-1 max-lg:gap-12">
			<!-- Left: Copy -->
			<div>
				<span class="dev-el font-mono text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-brand mb-5 block" style="--i: 0">
					Developers
				</span>
				<h2 class="dev-el font-display text-[clamp(2rem,4.5vw,3.25rem)] font-normal leading-[1.1] tracking-[-0.02em] text-text-primary mb-5" style="--i: 1">
					Ship with the SDK,<br class="max-md:hidden"> or stay in the dashboard
				</h2>
				<p class="dev-el text-[0.9375rem] text-text-secondary leading-[1.75] mb-8" style="--i: 2">
					Send transactional emails, manage contacts, and trigger automations with a single API call. Use the TypeScript SDK for type-safe integrations or hit the REST API directly from any language.
				</p>

				<!-- Capability pills -->
				<div class="dev-el flex flex-wrap gap-2 mb-8" style="--i: 3">
					<span
						v-for="(cap, i) in capabilities" :key="cap.label"
						class="capability-pill inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.75rem] font-medium text-text-tertiary border border-border-default transition-all duration-(--motion-moderate) hover:border-brand/30 hover:text-brand hover:bg-brand-soft cursor-default"
						:style="{ transitionDelay: `${i * 50}ms` }"
					>
						<!-- Send icon -->
						<svg v-if="cap.icon === 'send'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" />
						</svg>
						<!-- Users icon -->
						<svg v-else-if="cap.icon === 'users'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
						</svg>
						<!-- Zap icon -->
						<svg v-else-if="cap.icon === 'zap'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
						</svg>
						<!-- Bar chart icon -->
						<svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M12 20V10" /><path d="M18 20V4" /><path d="M6 20v-4" />
						</svg>
						{{ cap.label }}
					</span>
				</div>

				<div class="dev-el flex gap-5" style="--i: 4">
					<a href="https://docs.owlat.app/api/sdk" class="dev-link relative text-[0.8125rem] font-medium text-brand hover:text-brand-hover transition-colors no-underline pb-0.5">
						SDK Reference
					</a>
					<a href="https://docs.owlat.app/api/" class="dev-link relative text-[0.8125rem] font-medium text-brand hover:text-brand-hover transition-colors no-underline pb-0.5">
						API Docs
					</a>
				</div>
			</div>

			<!-- Right: Code window -->
			<div class="dev-code">
				<div class="flex gap-px -mb-px relative z-[1] px-0.5">
					<button
						v-for="tab in (['sdk', 'curl'] as const)"
						:key="tab"
						class="tab-btn px-4 py-2 font-mono text-[0.625rem] font-medium tracking-[0.04em] uppercase cursor-pointer transition-all duration-(--motion-moderate) border-none rounded-t-lg relative"
						:class="activeTab === tab
							? 'text-brand bg-[var(--owlat-code-bg)]'
							: 'text-text-disabled bg-transparent hover:text-text-tertiary'"
						@click="activeTab = tab"
					>
						{{ tab === 'sdk' ? 'TypeScript SDK' : 'cURL' }}
						<!-- Active tab indicator -->
						<span
							v-if="activeTab === tab"
							class="absolute bottom-0 left-2 right-2 h-[2px] bg-brand rounded-full"
							style="transition: all var(--motion-moderate) var(--ease-spring)"
						/>
					</button>
				</div>
				<div
					class="code-window border border-border-default rounded-[0_16px_16px_16px] overflow-hidden max-md:rounded-2xl relative"
					style="background: var(--owlat-code-bg); box-shadow: var(--shadow-card)"
				>
					<!-- Window chrome -->
					<div class="flex items-center gap-1.5 px-4 py-3 border-b border-border-default">
						<span class="w-[7px] h-[7px] rounded-full" style="background: color-mix(in oklab, #c46b5a 55%, var(--color-border-strong))" />
						<span class="w-[7px] h-[7px] rounded-full" style="background: color-mix(in oklab, #c9a55a 45%, var(--color-border-strong))" />
						<span class="w-[7px] h-[7px] rounded-full" style="background: color-mix(in oklab, #7a9b6e 45%, var(--color-border-strong))" />
						<span class="ml-auto flex items-center gap-3">
							<span class="font-mono text-[0.625rem] font-medium uppercase tracking-[0.06em] text-text-tertiary">
								{{ activeTab === 'sdk' ? 'typescript' : 'bash' }}
							</span>
							<!-- Copy button -->
							<button
								class="copy-btn flex items-center gap-1.5 px-2 py-1 rounded-md text-text-disabled hover:text-text-secondary hover:bg-bg-surface transition-all duration-(--motion-moderate) cursor-pointer border-none bg-transparent"
								:class="{ 'text-success!': copied }"
								@click="copyCode"
							>
								<svg v-if="!copied" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
								</svg>
								<svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
									<path d="M20 6 9 17l-5-5" />
								</svg>
								<span class="text-[0.6rem] font-medium font-mono">{{ copied ? 'Copied' : 'Copy' }}</span>
							</button>
						</span>
					</div>

					<!-- Code content with transition -->
					<Transition name="code-fade" mode="out-in">
						<!-- SDK code -->
						<pre v-if="activeTab === 'sdk'" key="sdk" class="px-5 py-5 m-0 overflow-x-auto font-mono text-[0.75rem] leading-[1.85] text-text-secondary"><code class="font-[inherit]"><span class="c-kw">import</span> { Owlat } <span class="c-kw">from</span> <span class="c-str">'@owlat/sdk-js'</span>

<span class="c-kw">const</span> owlat = <span class="c-kw">new</span> <span class="c-fn">Owlat</span>(<span class="c-str">'lm_live_...'</span>)

<span class="c-comment">// Send a transactional email</span>
<span class="c-kw">await</span> owlat.transactional.<span class="c-fn">send</span>({
  <span class="c-prop">email</span>: <span class="c-str">'mira@acme.io'</span>,
  <span class="c-prop">slug</span>:  <span class="c-str">'welcome-email'</span>,
  <span class="c-prop">dataVariables</span>: { <span class="c-prop">firstName</span>: <span class="c-str">'Mira'</span> }
})

<span class="c-comment">// Create a contact and add to a list</span>
<span class="c-kw">const</span> contact = <span class="c-kw">await</span> owlat.contacts.<span class="c-fn">create</span>({
  <span class="c-prop">email</span>: <span class="c-str">'mira@acme.io'</span>,
  <span class="c-prop">firstName</span>: <span class="c-str">'Mira'</span>
})

<span class="c-kw">await</span> owlat.lists.<span class="c-fn">addContact</span>({
  <span class="c-prop">listId</span>: <span class="c-str">'list_abc123'</span>,
  <span class="c-prop">email</span>:  <span class="c-str">'mira@acme.io'</span>
})</code></pre>
						<!-- cURL code -->
						<pre v-else key="curl" class="px-5 py-5 m-0 overflow-x-auto font-mono text-[0.75rem] leading-[1.85] text-text-secondary"><code class="font-[inherit]"><span class="c-comment"># Send a transactional email</span>
<span class="c-fn">curl</span> -X POST https://your-deployment.convex.site/api/v1/transactional \
  -H <span class="c-str">"Authorization: Bearer lm_live_..."</span> \
  -H <span class="c-str">"Content-Type: application/json"</span> \
  -d <span class="c-str">'{
    "slug": "welcome-email",
    "email": "mira@acme.io",
    "dataVariables": {
      "firstName": "Mira"
    }
  }'</span></code></pre>
					</Transition>
				</div>
			</div>
		</div>
	</section>
</template>

<style scoped>
.dev-el {
	opacity: 0;
	transform: translateY(14px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--i, 0) * 0.07s);
}

.dev-code {
	opacity: 0;
	transform: translateY(18px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: 0.15s;
}

.visible .dev-el,
.visible .dev-code {
	opacity: 1;
	transform: none;
}

/* Dev link animated underline */
.dev-link::after {
	content: '';
	position: absolute;
	bottom: 0;
	left: 0;
	right: 100%;
	height: 1px;
	background: var(--color-brand);
	transition: right var(--motion-moderate) var(--ease-spring);
}

.dev-link:hover::after {
	right: 0;
}

/* Capability pill entrance */
.visible .capability-pill {
	animation: pill-in var(--motion-slow) var(--ease-spring) backwards;
}

@keyframes pill-in {
	from {
		opacity: 0;
		transform: translateY(8px) scale(0.95);
	}
}

.code-window {
	transition: box-shadow var(--motion-moderate) var(--ease-spring);
}

.code-window:hover {
	box-shadow: var(--shadow-3);
}

/* Copy button feedback */
.copy-btn {
	transition: all var(--motion-moderate) var(--ease-spring);
}

.copy-btn:active {
	transform: scale(0.95);
}

/* Tab switch animation */
.code-fade-enter-active,
.code-fade-leave-active {
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
}

.code-fade-enter-from {
	opacity: 0;
	transform: translateY(4px);
}

.code-fade-leave-to {
	opacity: 0;
	transform: translateY(-4px);
}
</style>
