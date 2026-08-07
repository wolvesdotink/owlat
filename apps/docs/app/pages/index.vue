<script setup lang="ts">
definePageMeta({ layout: 'home' })

useSeoMeta({
	title: 'Owlat Docs — Email Infrastructure for Product Teams',
	ogTitle: 'Owlat Docs — Email Infrastructure for Product Teams',
	description: 'Product guides, API reference, and developer docs for Owlat. Build, send, and optimize email with drag-and-drop templates, transactional APIs, and deliverability tooling.',
	ogDescription: 'Product guides, API reference, and developer docs for Owlat. Build, send, and optimize email with drag-and-drop templates, transactional APIs, and deliverability tooling.',
})

defineOgImage('Docs', { title: 'Owlat Docs', description: 'Email infrastructure for product teams' })

const visible = ref(false)
const activeTab = ref<'sdk' | 'java' | 'curl'>('sdk')

const tabFiles: Record<'sdk' | 'java' | 'curl', string> = {
	sdk: 'send.ts',
	java: 'Send.java',
	curl: 'terminal',
}

const { target: linksRef, isVisible: linksVisible } = useScrollReveal()
const { target: guidesRef, isVisible: guidesVisible } = useScrollReveal()
const { target: codeRef, isVisible: codeVisible } = useScrollReveal()
const { target: ossRef, isVisible: ossVisible } = useScrollReveal()

onMounted(() => {
	requestAnimationFrame(() => {
		visible.value = true
	})
})

const sections = [
	{
		label: 'Guide',
		href: '/guide/getting-started',
		description: 'Product workflows, setup, and day-to-day operations',
		count: '19 articles',
		icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253',
	},
	{
		label: 'API Reference',
		href: '/api',
		description: 'Authenticated and public HTTP endpoint reference',
		count: '11 references',
		icon: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
	},
	{
		label: 'Developer',
		href: '/developer',
		description: 'Architecture, backend patterns, and component system',
		count: '12 guides',
		icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
	},
	{
		label: 'SDKs',
		href: '/api/sdk',
		description: 'Official TypeScript and Java SDKs for server-side integration',
		count: '2 references',
		icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
	},
	{
		label: 'Examples',
		href: '/examples',
		description: 'Copy-pasteable integration patterns for common use cases',
		count: '6 examples',
		icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
	},
]

const popularGuides = [
	{ title: 'Quick Start', href: '/guide/quick-start', description: 'Get up and running in 5 minutes' },
	{ title: 'Email Editor', href: '/guide/email-editor', description: 'Build emails with the block-based editor' },
	{ title: 'Campaigns', href: '/guide/campaigns', description: 'Send and track email campaigns' },
	{ title: 'Transactional Setup', href: '/guide/transactional', description: 'Send transactional emails via API' },
	{ title: 'Contacts', href: '/guide/contacts', description: 'Manage your audience and contacts' },
	{ title: 'Deliverability', href: '/guide/deliverability', description: 'Optimize inbox placement and sender reputation' },
]
</script>

<template>
	<div :class="['landing', { visible }]">
		<!-- Hero -->
		<section class="hero-section">
			<div class="hero-aurora" aria-hidden="true" />
			<div class="hero-container">
				<div class="hero-grid">
					<!-- Left column -->
					<div class="hero-content">
						<span class="eyebrow anim-badge">Documentation</span>

						<h1 class="hero-title anim-title">
							Email infrastructure,
							<span class="title-accent title-warm">end to end.</span>
						</h1>

						<p class="hero-tagline anim-tagline">
							Everything you need to build, send, and optimize email — from drag-and-drop
							templates to transactional APIs and deliverability tooling.
						</p>

						<div class="hero-actions anim-actions">
							<NuxtLink to="/guide/getting-started" class="btn btn-primary group no-underline">
								<span>Start with the Guide</span>
								<svg class="arrow-nudge" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<path d="M5 12h14" />
									<path d="m12 5 7 7-7 7" />
								</svg>
							</NuxtLink>
							<NuxtLink to="/api" class="btn btn-hairline group no-underline">
								<span>Explore the API</span>
								<svg class="arrow-nudge" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<path d="M5 12h14" />
									<path d="m12 5 7 7-7 7" />
								</svg>
							</NuxtLink>
						</div>
					</div>

					<!-- Right column: SDK snippet -->
					<div class="hero-snippet anim-snippet">
						<div class="snippet-card">
							<div class="window-chrome">
								<div class="chrome-dots">
									<span v-for="i in 3" :key="i" class="dot" />
								</div>
								<span class="chrome-pill">quickstart.ts</span>
							</div>
							<div class="snippet-body">
								<pre><code><span class="c-kw">import</span> { Owlat } <span class="c-kw">from</span> <span class="c-str">'@owlat/sdk-js'</span>

<span class="c-kw">const</span> owlat = <span class="c-kw">new</span> <span class="c-fn">Owlat</span>(<span class="c-str">'lm_live_...'</span>)

<span class="c-kw">await</span> owlat.transactional.<span class="c-fn">send</span>({
  <span class="c-prop">email</span>: <span class="c-str">'mira@acme.io'</span>,
  <span class="c-prop">slug</span>:  <span class="c-str">'welcome-email'</span>,
  <span class="c-prop">dataVariables</span>: { <span class="c-prop">firstName</span>: <span class="c-str">'Mira'</span> }
})</code></pre>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>

		<!-- Quick Links -->
		<section ref="linksRef" :class="['quick-links-section', { visible: linksVisible }]">
			<div class="section-container">
				<div class="sections-grid">
					<NuxtLink
						v-for="(section, i) in sections"
						:key="section.label"
						:to="section.href"
						class="section-card reveal-item"
						:style="{ '--i': i }"
					>
						<div class="section-card-header">
							<div class="section-icon">
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
									<path :d="section.icon" />
								</svg>
							</div>
							<span class="section-label">{{ section.label }}</span>
							<span class="section-count">{{ section.count }}</span>
						</div>
						<p class="section-description">{{ section.description }}</p>
						<svg class="section-arrow" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M3.33 8h9.34M8.67 4l4 4-4 4" />
						</svg>
					</NuxtLink>
				</div>
			</div>
		</section>

		<!-- Popular Guides -->
		<section ref="guidesRef" :class="['popular-section', { visible: guidesVisible }]">
			<div class="section-container">
				<div class="section-header reveal-item" :style="{ '--i': 0 }">
					<span class="eyebrow">Guides</span>
					<h2 class="section-title">Popular <span class="title-accent">guides.</span></h2>
				</div>
				<div class="guides-grid">
					<NuxtLink
						v-for="(guide, i) in popularGuides"
						:key="guide.title"
						:to="guide.href"
						class="guide-card reveal-item"
						:style="{ '--i': i + 1 }"
					>
						<h3 class="guide-title">{{ guide.title }}</h3>
						<p class="guide-description">{{ guide.description }}</p>
						<svg class="guide-arrow" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M3.33 8h9.34M8.67 4l4 4-4 4" />
						</svg>
					</NuxtLink>
				</div>
			</div>
		</section>

		<!-- Code Preview -->
		<section ref="codeRef" :class="['code-section', { visible: codeVisible }]">
			<div class="section-container">
				<div class="section-header reveal-item" :style="{ '--i': 0 }">
					<span class="eyebrow">Quickstart</span>
					<h2 class="section-title">Send your first email in <span class="title-accent">seconds.</span></h2>
				</div>

				<div class="code-window reveal-item" :style="{ '--i': 1 }">
					<div class="window-chrome">
						<div class="chrome-dots">
							<span v-for="i in 3" :key="i" class="dot" />
						</div>
						<span class="chrome-pill chrome-pill-center">{{ tabFiles[activeTab] }}</span>
						<div class="code-tabs">
							<button
								:class="['code-tab', { active: activeTab === 'sdk' }]"
								@click="activeTab = 'sdk'"
							>
								TypeScript
							</button>
							<button
								:class="['code-tab', { active: activeTab === 'java' }]"
								@click="activeTab = 'java'"
							>
								Java
							</button>
							<button
								:class="['code-tab', { active: activeTab === 'curl' }]"
								@click="activeTab = 'curl'"
							>
								cURL
							</button>
						</div>
					</div>

					<div class="code-body">
						<!-- TypeScript -->
						<Transition name="code-fade" mode="out-in">
							<pre v-if="activeTab === 'sdk'" key="sdk"><code><span class="c-kw">import</span> { Owlat } <span class="c-kw">from</span> <span class="c-str">'@owlat/sdk-js'</span>

<span class="c-kw">const</span> owlat = <span class="c-kw">new</span> <span class="c-fn">Owlat</span>(<span class="c-str">'lm_live_...'</span>)

<span class="c-comment">// Send a transactional email</span>
<span class="c-kw">await</span> owlat.transactional.<span class="c-fn">send</span>({
  <span class="c-prop">email</span>: <span class="c-str">'mira@acme.io'</span>,
  <span class="c-prop">slug</span>:  <span class="c-str">'welcome-email'</span>,
  <span class="c-prop">dataVariables</span>: { <span class="c-prop">firstName</span>: <span class="c-str">'Mira'</span> }
})

<span class="c-comment">// Create a contact and add to a topic</span>
<span class="c-kw">const</span> contact = <span class="c-kw">await</span> owlat.contacts.<span class="c-fn">create</span>({
  <span class="c-prop">email</span>: <span class="c-str">'mira@acme.io'</span>,
  <span class="c-prop">firstName</span>: <span class="c-str">'Mira'</span>
})

<span class="c-kw">await</span> owlat.topics.<span class="c-fn">addContact</span>({
  <span class="c-prop">topicId</span>: <span class="c-str">'topic_abc123'</span>,
  <span class="c-prop">email</span>:  <span class="c-str">'mira@acme.io'</span>
})</code></pre>

							<!-- Java -->
							<pre v-else-if="activeTab === 'java'" key="java"><code><span class="c-kw">import</span> com.owlat.sdk.Owlat;
<span class="c-kw">import</span> com.owlat.sdk.model.transactional.*;

Owlat owlat = <span class="c-kw">new</span> <span class="c-fn">Owlat</span>(<span class="c-str">"lm_live_..."</span>);

<span class="c-comment">// Send a transactional email</span>
owlat.<span class="c-fn">transactional</span>().<span class="c-fn">send</span>(
    SendParams.<span class="c-fn">builder</span>(<span class="c-str">"mira@acme.io"</span>, <span class="c-str">"welcome-email"</span>)
        .<span class="c-fn">dataVariable</span>(<span class="c-str">"firstName"</span>, <span class="c-str">"Mira"</span>)
        .<span class="c-fn">build</span>()
);

<span class="c-comment">// Create a contact and add to a list</span>
Contact contact = owlat.<span class="c-fn">contacts</span>().<span class="c-fn">create</span>(
    CreateContactParams.<span class="c-fn">builder</span>(<span class="c-str">"mira@acme.io"</span>)
        .<span class="c-fn">firstName</span>(<span class="c-str">"Mira"</span>)
        .<span class="c-fn">build</span>()
);</code></pre>

							<!-- cURL -->
							<pre v-else key="curl"><code><span class="c-comment"># Send a transactional email</span>
curl -X POST https://your-deployment.convex.site/api/v1/transactional \
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

		<!-- Open Source Callout -->
		<section ref="ossRef" :class="['oss-section', { visible: ossVisible }]">
			<div class="section-container">
				<div class="oss-banner reveal-item" :style="{ '--i': 0 }">
					<div class="oss-content">
						<div class="oss-icon-row">
							<svg class="oss-icon" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
								<path d="M12 .3a12 12 0 0 0-3.8 23.38c.6.11.82-.26.82-.58l-.01-2.05c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49 1 .1-.78.42-1.3.76-1.6-2.67-.31-5.47-1.34-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6.02 0c2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.18a4.65 4.65 0 0 1 1.24 3.22c0 4.61-2.81 5.62-5.48 5.92.43.37.81 1.1.81 2.22l-.01 3.29c0 .32.21.7.82.58A12 12 0 0 0 12 .3" />
							</svg>
							<span class="oss-label">Open <span class="title-accent">source.</span></span>
						</div>
						<p class="oss-description">
							Owlat is open source and community-driven. Explore the codebase,
							report issues, or contribute on GitHub.
						</p>
						<a
							href="https://github.com/wolvesdotink/owlat"
							target="_blank"
							rel="noopener noreferrer"
							class="btn btn-hairline btn-sm group oss-link no-underline"
						>
							<span>View on GitHub</span>
							<svg class="arrow-nudge" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<path d="M3.33 8h9.34M8.67 4l4 4-4 4" />
							</svg>
						</a>
					</div>
				</div>
			</div>
		</section>

		<!-- Footer -->
		<footer class="landing-footer">
			<div class="section-container">
				<p class="footer-copy">&copy; {{ new Date().getFullYear() }} <a href="https://wolves.ink">Wolves</a>. All rights reserved.</p>
			</div>
		</footer>
	</div>
</template>

<style scoped>
/* ── Layout ── */
.landing {
	overflow-x: hidden;
}

.section-container {
	max-width: 1120px;
	margin: 0 auto;
	padding: 0 24px;
}

/* ── Section rhythm: eyebrow → title → sub ── */
.eyebrow {
	display: block;
	font-size: var(--text-caption);
	line-height: var(--text-caption--line-height);
	font-weight: 450;
	text-transform: uppercase;
	letter-spacing: 0.1em;
	color: var(--color-text-tertiary);
}

.section-title {
	font-size: clamp(1.5rem, 3vw, 2rem);
	font-weight: 450;
	letter-spacing: -0.02em;
	line-height: 1.15;
	color: var(--color-text-primary);
	margin-top: 8px;
}

.title-accent {
	font-family: var(--font-display);
	font-style: italic;
	font-weight: 400;
	letter-spacing: -0.01em;
}

/* Warm gradient for the hero's display phrase. */
.title-warm {
	background: linear-gradient(100deg, var(--color-text-primary) 15%, var(--color-brand) 80%);
	-webkit-background-clip: text;
	background-clip: text;
	color: transparent;
}

.section-header {
	margin-bottom: 28px;
}

/* ── Scroll Reveal ── */
.reveal-item {
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
	transition-delay: calc(var(--i, 0) * 0.05s);
}

.visible .reveal-item {
	opacity: 1;
	transform: translateY(0);
}

/* ── Hero ── */
.hero-section {
	position: relative;
	padding: 96px 0 72px;
	overflow: hidden;
}

/* Restrained bottom aurora — static terracotta wash anchored below the fold */
.hero-aurora {
	position: absolute;
	left: 18%;
	right: 18%;
	bottom: -34vh;
	height: 40vh;
	border-radius: 50%;
	filter: blur(120px);
	background: radial-gradient(ellipse closest-side, rgba(196, 120, 90, 0.16), transparent 72%);
	pointer-events: none;
}

.hero-container {
	position: relative;
	max-width: 1120px;
	margin: 0 auto;
	padding: 0 24px;
	z-index: 1;
}

.hero-grid {
	display: grid;
	grid-template-columns: 1.15fr 0.85fr;
	gap: 48px;
	align-items: center;
}

.hero-title {
	margin-top: 16px;
	font-size: clamp(2.25rem, 4.5vw, 3.25rem);
	font-weight: 450;
	letter-spacing: -0.02em;
	line-height: 1.12;
	color: var(--color-text-primary);
}

.hero-title .title-accent {
	display: block;
	padding-bottom: 2px;
}

.hero-tagline {
	margin-top: 18px;
	font-size: var(--text-md);
	line-height: 1.65;
	color: var(--color-text-secondary);
	max-width: 480px;
}

.hero-actions {
	display: flex;
	gap: 12px;
	margin-top: 32px;
	flex-wrap: wrap;
}

/* Arrow nudge inside pill CTAs / links */
.arrow-nudge {
	transition: transform var(--motion-fast) var(--ease-spring);
}

.group:hover .arrow-nudge {
	transform: translateX(3px);
}

/* ── Window chrome (shared by snippet + code window) ── */
.window-chrome {
	position: relative;
	display: flex;
	align-items: center;
	padding: 10px 14px;
	border-bottom: 1px solid var(--color-border-subtle);
	background: var(--surface-1);
}

.chrome-dots {
	display: flex;
	gap: 6px;
}

.dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: var(--color-border-strong);
}

.chrome-pill {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	position: absolute;
	left: 50%;
	transform: translateX(-50%);
	padding: 2px 12px;
	border: 1px solid var(--color-border-subtle);
	border-radius: 9999px;
	background: var(--surface-3);
	font-family: var(--font-mono);
	font-size: 10px;
	color: var(--color-text-tertiary);
	white-space: nowrap;
}

/* ── Hero Snippet ── */
.snippet-card {
	border-radius: var(--radius-card);
	overflow: hidden;
	background: var(--surface-3);
	border: 1px solid var(--color-border-subtle);
	box-shadow: var(--shadow-4);
}

.snippet-body {
	padding: 18px 20px;
	overflow-x: auto;
}

.snippet-body pre,
.code-body pre {
	margin: 0;
	font-size: 13.5px;
	line-height: 1.7;
	font-family: var(--font-mono);
	color: var(--color-text-primary);
	white-space: pre;
}

/* ── Cards (shared recipe: white, hairline, hover lift) ── */
.section-card,
.guide-card,
.oss-banner {
	background: var(--surface-3);
	border: 1px solid var(--color-border-subtle);
	border-radius: var(--radius-card);
	box-shadow: var(--shadow-1);
	text-decoration: none;
	transition:
		border-color var(--motion-fast) var(--ease-spring),
		box-shadow var(--motion-fast) var(--ease-spring);
}

.section-card:hover,
.guide-card:hover,
.oss-banner:hover {
	border-color: var(--color-border-default);
	box-shadow: var(--shadow-3);
}

/* ── Quick Links ── */
.quick-links-section {
	padding: 0 0 64px;
}

.sections-grid {
	display: grid;
	grid-template-columns: 3fr 2fr;
	gap: 14px;
}

.section-card {
	position: relative;
	display: block;
	padding: 22px 24px;
}

.section-card-header {
	display: flex;
	align-items: center;
	gap: 10px;
}

.section-icon {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 32px;
	height: 32px;
	border-radius: 10px;
	background: var(--color-brand-soft);
	color: var(--color-brand);
	transition: background var(--motion-fast) var(--ease-spring);
}

.section-card:hover .section-icon {
	background: color-mix(in srgb, var(--color-brand) 15%, transparent);
}

.section-label {
	font-size: 16px;
	font-weight: 550;
	color: var(--color-text-primary);
}

.section-count {
	font-size: var(--text-2xs);
	font-weight: 450;
	padding: 2px 9px;
	border-radius: 9999px;
	color: var(--color-text-tertiary);
	border: 1px solid var(--color-border-subtle);
}

.section-description {
	margin-top: 6px;
	font-size: 14.5px;
	line-height: 1.5;
	color: var(--color-text-secondary);
	padding-left: 42px;
}

.section-arrow {
	position: absolute;
	top: 22px;
	right: 20px;
	color: var(--color-text-tertiary);
	opacity: 0;
	transform: translateX(-4px);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
}

.section-card:hover .section-arrow {
	opacity: 1;
	transform: translateX(0);
}

/* ── Popular Guides ── */
.popular-section {
	padding: 0 0 80px;
}

.guides-grid {
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: 14px;
}

.guide-card {
	position: relative;
	display: block;
	padding: 20px 22px;
}

.guide-title {
	font-size: 16px;
	font-weight: 550;
	color: var(--color-text-primary);
	transition: color var(--motion-fast) var(--ease-spring);
}

.guide-card:hover .guide-title {
	color: var(--color-brand);
}

.guide-description {
	margin-top: 4px;
	font-size: 14px;
	line-height: 1.5;
	color: var(--color-text-secondary);
}

.guide-arrow {
	position: absolute;
	top: 20px;
	right: 18px;
	color: var(--color-text-tertiary);
	opacity: 0;
	transform: translateX(-4px);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
}

.guide-card:hover .guide-arrow {
	opacity: 1;
	transform: translateX(0);
}

/* ── Code Preview ── */
.code-section {
	padding: 0 0 80px;
}

.code-window {
	border-radius: var(--radius-card);
	overflow: hidden;
	background: var(--surface-3);
	border: 1px solid var(--color-border-subtle);
	box-shadow: var(--shadow-2);
}

.code-tabs {
	display: flex;
	gap: 2px;
	margin-left: auto;
	background: var(--color-bg-soft);
	border-radius: 9999px;
	padding: 2px;
}

.code-tab {
	padding: 4px 14px;
	font-size: var(--text-caption);
	font-weight: 450;
	color: var(--color-text-tertiary);
	background: transparent;
	border: none;
	border-radius: 9999px;
	cursor: pointer;
	transition:
		color var(--motion-fast) var(--ease-spring),
		background var(--motion-fast) var(--ease-spring),
		box-shadow var(--motion-fast) var(--ease-spring);
}

.code-tab:hover {
	color: var(--color-text-secondary);
}

.code-tab.active {
	color: var(--color-text-primary);
	font-weight: 550;
	background: var(--surface-3);
	box-shadow: var(--shadow-1);
}

.code-body {
	padding: 22px 24px;
	overflow-x: auto;
}

/* Code tab transition — content swap on the moderate tier */
.code-fade-enter-active {
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
}

.code-fade-leave-active {
	transition:
		opacity var(--motion-moderate-exit) var(--ease-exit),
		transform var(--motion-moderate-exit) var(--ease-exit);
}

.code-fade-enter-from {
	opacity: 0;
	transform: translateY(4px);
}

.code-fade-leave-to {
	opacity: 0;
	transform: translateY(-4px);
}

/* ── Open Source ── */
.oss-section {
	padding: 0 0 64px;
}

.oss-banner {
	display: block;
	padding: 32px 36px;
}

.oss-content {
	max-width: 520px;
}

.oss-icon-row {
	display: flex;
	align-items: center;
	gap: 10px;
}

.oss-icon {
	color: var(--color-text-primary);
}

.oss-label {
	font-size: 1.25rem;
	font-weight: 450;
	letter-spacing: -0.01em;
	color: var(--color-text-primary);
}

.oss-description {
	margin-top: 10px;
	font-size: var(--text-md);
	line-height: 1.6;
	color: var(--color-text-secondary);
}

.oss-link {
	margin-top: 18px;
}

/* ── Footer ── */
.landing-footer {
	padding: 32px 0;
	border-top: 1px solid var(--color-border-subtle);
}

.footer-copy {
	font-size: 14px;
	color: var(--color-text-tertiary);
}

/* ── Entrance Animations ── */
.anim-badge,
.anim-title,
.anim-tagline,
.anim-actions,
.anim-snippet {
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-slow) var(--ease-spring),
		transform var(--motion-slow) var(--ease-spring);
}

.anim-snippet {
	transform: translateY(12px);
}

.visible .anim-badge {
	opacity: 1;
	transform: translateY(0);
	transition-delay: 0.05s;
}

.visible .anim-title {
	opacity: 1;
	transform: translateY(0);
	transition-delay: 0.1s;
}

.visible .anim-tagline {
	opacity: 1;
	transform: translateY(0);
	transition-delay: 0.18s;
}

.visible .anim-actions {
	opacity: 1;
	transform: translateY(0);
	transition-delay: 0.26s;
}

.visible .anim-snippet {
	opacity: 1;
	transform: translateY(0);
	transition-delay: 0.22s;
}

/* ── Responsive ── */
@media (max-width: 860px) {
	.hero-grid {
		grid-template-columns: 1fr;
		gap: 36px;
	}

	.sections-grid {
		grid-template-columns: 1fr;
	}

	.guides-grid {
		grid-template-columns: repeat(2, 1fr);
	}
}

@media (max-width: 580px) {
	.hero-section {
		padding: 64px 0 48px;
	}

	.hero-actions {
		flex-direction: column;
		align-items: stretch;
	}

	.guides-grid {
		grid-template-columns: 1fr;
	}

	.chrome-pill-center {
		display: none;
	}

	.code-tabs {
		margin-left: auto;
	}

	.section-description {
		padding-left: 0;
	}
}

/* ── Syntax Highlighting (tokenized via main.css — flips with color mode) ── */
.c-kw { color: var(--color-brand); font-weight: 500; }
.c-fn { color: var(--color-syntax-fn); }
.c-str { color: var(--color-syntax-str); }
.c-prop { color: var(--color-text-primary); }
.c-comment { color: var(--color-text-tertiary); }
</style>
