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
			<div class="hero-container">
				<div class="hero-grid">
					<!-- Left column -->
					<div class="hero-content">
						<span class="hero-badge anim-badge">Documentation</span>

						<div class="hero-title-row anim-title">
							<div
								class="hero-logo"
								style="
									-webkit-mask: url('/logo.svg') no-repeat center / contain;
									mask: url('/logo.svg') no-repeat center / contain;
									background: var(--color-brand);
								"
								aria-hidden="true"
							/>
							<h1 class="hero-title">Owlat</h1>
						</div>

						<p class="hero-subtitle anim-subtitle">Email infrastructure for product teams</p>

						<p class="hero-tagline anim-tagline">
							Everything you need to build, send, and optimize email — from drag-and-drop
							templates to transactional APIs and deliverability tooling.
						</p>

						<div class="hero-accent anim-accent" />

						<div class="hero-actions anim-actions">
							<NuxtLink to="/guide/getting-started" class="btn-primary">
								Start with the Guide
								<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<path d="M3.33 8h9.34M8.67 4l4 4-4 4" />
								</svg>
							</NuxtLink>
							<NuxtLink to="/api" class="btn-secondary">
								Explore the API
							</NuxtLink>
						</div>
					</div>

					<!-- Right column: SDK snippet -->
					<div class="hero-snippet anim-snippet">
						<div class="snippet-card">
							<div class="snippet-chrome">
								<div class="chrome-dots">
									<span class="dot dot-red" />
									<span class="dot dot-yellow" />
									<span class="dot dot-green" />
								</div>
								<span class="chrome-label">TypeScript</span>
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
				<h2 class="section-heading reveal-item" :style="{ '--i': 0 }">Popular Guides</h2>
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
				<h2 class="section-heading reveal-item" :style="{ '--i': 0 }">Send your first email in seconds</h2>

				<div class="code-window reveal-item" :style="{ '--i': 1 }">
					<div class="code-chrome">
						<div class="chrome-dots">
							<span class="dot dot-red" />
							<span class="dot dot-yellow" />
							<span class="dot dot-green" />
						</div>
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
							<span class="oss-label">Open Source</span>
						</div>
						<p class="oss-description">
							Owlat is open source and community-driven. Explore the codebase,
							report issues, or contribute on GitHub.
						</p>
						<a
							href="https://github.com/wolvesdotink/owlat"
							target="_blank"
							rel="noopener noreferrer"
							class="oss-link"
						>
							View on GitHub
							<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
	padding: 80px 0 64px;
	overflow: hidden;
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

.hero-badge {
	display: inline-block;
	padding: 4px 14px;
	font-size: 12px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.08em;
	color: var(--color-brand);
	background: var(--color-brand-soft, rgba(191, 106, 62, 0.1));
	border: 1px solid color-mix(in srgb, var(--color-brand) 30%, transparent);
	border-radius: 9999px;
}

.hero-title-row {
	display: flex;
	align-items: center;
	gap: 14px;
	margin-top: 24px;
}

.hero-logo {
	width: 48px;
	height: 48px;
}

.hero-title {
	font-family: var(--font-display, ui-serif, Georgia, serif);
	font-size: 48px;
	font-weight: 700;
	color: var(--color-text-primary);
	line-height: 1.1;
}

.hero-subtitle {
	margin-top: 16px;
	font-family: var(--font-display, ui-serif, Georgia, serif);
	font-size: 22px;
	font-weight: 500;
	color: var(--color-text-primary);
	line-height: 1.3;
}

.hero-tagline {
	margin-top: 14px;
	font-size: 16px;
	line-height: 1.65;
	color: var(--color-text-secondary);
	max-width: 480px;
}

.hero-accent {
	margin-top: 20px;
	width: 40px;
	height: 2px;
	background: var(--color-brand);
	opacity: 0.6;
	border-radius: 1px;
}

.hero-actions {
	display: flex;
	gap: 12px;
	margin-top: 28px;
}

/* ── Buttons ── */
.btn-primary {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	padding: 10px 22px;
	font-size: 15px;
	font-weight: 600;
	color: #fff;
	background: var(--color-brand);
	border: 1px solid var(--color-brand);
	border-radius: 8px;
	text-decoration: none;
	transition:
		background var(--motion-fast) var(--ease-spring),
		transform var(--motion-fast) var(--ease-spring);
}

.btn-primary:hover {
	background: var(--color-brand-hover);
}

.btn-primary:active {
	transform: scale(0.98);
}

.btn-primary svg {
	transition: transform var(--motion-moderate) var(--ease-spring);
}

.btn-primary:hover svg {
	transform: translateX(2px);
}

.btn-secondary {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	padding: 10px 22px;
	font-size: 15px;
	font-weight: 600;
	color: var(--color-text-primary);
	background: transparent;
	border: 1px solid var(--color-border-default);
	border-radius: 8px;
	text-decoration: none;
	transition:
		border-color var(--motion-fast) var(--ease-spring),
		background var(--motion-fast) var(--ease-spring),
		transform var(--motion-fast) var(--ease-spring);
}

.btn-secondary:hover {
	border-color: var(--color-brand);
	background: var(--color-brand-soft, rgba(191, 106, 62, 0.06));
}

.btn-secondary:active {
	transform: scale(0.98);
}

/* ── Hero Snippet ── */
.snippet-card {
	border-radius: var(--radius-card);
	overflow: hidden;
	background: var(--surface-2);
	box-shadow: var(--shadow-2);
}

.snippet-chrome {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 10px 16px;
	border-bottom: 1px solid var(--color-border-subtle);
	background: var(--color-bg-surface);
}

.chrome-dots {
	display: flex;
	gap: 6px;
}

.dot {
	width: 10px;
	height: 10px;
	border-radius: 50%;
}

.dot-red { background: #ec6a5e; }
.dot-yellow { background: #f4bf4f; }
.dot-green { background: #62c554; }

.chrome-label {
	font-size: 13px;
	font-weight: 500;
	color: var(--color-text-tertiary);
}

.snippet-body {
	padding: 18px 20px;
	overflow-x: auto;
}

.snippet-body pre,
.code-body pre {
	margin: 0;
	font-size: 14px;
	line-height: 1.7;
	font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
	color: var(--color-text-primary);
	white-space: pre;
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
	border-radius: var(--radius-card);
	background: var(--surface-2);
	box-shadow: var(--shadow-2);
	text-decoration: none;
	transition:
		background var(--motion-moderate) var(--ease-spring),
		box-shadow var(--motion-moderate) var(--ease-spring);
}

/* Hover: +6% surface, one elevation step */
.section-card:hover {
	background: var(--surface-2-hover);
	box-shadow: var(--shadow-3);
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
	border-radius: 8px;
	background: var(--color-brand-soft);
	color: var(--color-brand);
	transition: background var(--motion-fast) var(--ease-spring);
}

.section-card:hover .section-icon {
	background: color-mix(in srgb, var(--color-brand) 15%, transparent);
}

.section-label {
	font-size: 16px;
	font-weight: 600;
	color: var(--color-text-primary);
}

.section-count {
	font-size: 12px;
	font-weight: 500;
	padding: 2px 8px;
	border-radius: 9999px;
	color: var(--color-text-tertiary);
	background: var(--color-bg-soft);
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

.section-heading {
	font-family: var(--font-display, ui-serif, Georgia, serif);
	font-size: 24px;
	font-weight: 600;
	color: var(--color-text-primary);
	margin-bottom: 24px;
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
	border-radius: var(--radius-card);
	background: var(--surface-2);
	box-shadow: var(--shadow-2);
	text-decoration: none;
	transition:
		background var(--motion-moderate) var(--ease-spring),
		box-shadow var(--motion-moderate) var(--ease-spring);
}

.guide-card:hover {
	background: var(--surface-2-hover);
	box-shadow: var(--shadow-3);
}

.guide-title {
	font-size: 16px;
	font-weight: 600;
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
	background: var(--surface-2);
	box-shadow: var(--shadow-2);
}

.code-chrome {
	display: flex;
	align-items: center;
	gap: 16px;
	padding: 10px 16px;
	border-bottom: 1px solid var(--color-border-subtle);
	background: var(--color-bg-surface);
}

.code-tabs {
	display: flex;
	gap: 2px;
	margin-left: auto;
	background: var(--color-bg-soft);
	border-radius: 6px;
	padding: 2px;
}

.code-tab {
	padding: 4px 14px;
	font-size: 13px;
	font-weight: 500;
	color: var(--color-text-tertiary);
	background: transparent;
	border: none;
	border-radius: 5px;
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
	font-weight: var(--font-weight-medium, 500);
	background: var(--surface-4);
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
	padding: 32px 36px;
	border-radius: var(--radius-card);
	background: var(--surface-2);
	box-shadow: var(--shadow-2);
	transition:
		background var(--motion-moderate) var(--ease-spring),
		box-shadow var(--motion-moderate) var(--ease-spring);
}

.oss-banner:hover {
	background: var(--surface-2-hover);
	box-shadow: var(--shadow-3);
}

.oss-content {
	max-width: 520px;
	position: relative;
	z-index: 2;
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
	font-size: 16px;
	font-weight: 600;
	color: var(--color-text-primary);
}

.oss-description {
	margin-top: 8px;
	font-size: 15px;
	line-height: 1.6;
	color: var(--color-text-secondary);
}

.oss-link {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	margin-top: 16px;
	font-size: 15px;
	font-weight: 600;
	color: var(--color-brand);
	text-decoration: none;
	transition: gap var(--motion-moderate) var(--ease-spring);
}

.oss-link:hover {
	gap: 10px;
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
.anim-subtitle,
.anim-tagline,
.anim-accent,
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

.visible .anim-subtitle {
	opacity: 1;
	transform: translateY(0);
	transition-delay: 0.18s;
}

.visible .anim-tagline {
	opacity: 1;
	transform: translateY(0);
	transition-delay: 0.24s;
}

.visible .anim-accent {
	opacity: 1;
	transform: translateY(0);
	transition-delay: 0.28s;
}

.visible .anim-actions {
	opacity: 1;
	transform: translateY(0);
	transition-delay: 0.32s;
}

.visible .anim-snippet {
	opacity: 1;
	transform: translateY(0);
	transition-delay: 0.25s;
}

/* ── Responsive ── */
@media (max-width: 860px) {
	.hero-grid {
		grid-template-columns: 1fr;
		gap: 36px;
	}

	.hero-title {
		font-size: 38px;
	}

	.sections-grid {
		grid-template-columns: 1fr;
	}

	.guides-grid {
		grid-template-columns: repeat(2, 1fr);
	}

	.section-description {
		padding-left: 42px;
	}
}

@media (max-width: 580px) {
	.hero-section {
		padding: 56px 0 48px;
	}

	.hero-title {
		font-size: 32px;
	}

	.hero-logo {
		width: 38px;
		height: 38px;
	}

	.hero-actions {
		flex-direction: column;
	}

	.guides-grid {
		grid-template-columns: 1fr;
	}

	.code-tabs {
		margin-left: 0;
	}

	.code-chrome {
		flex-wrap: wrap;
		gap: 10px;
	}

	.section-description {
		padding-left: 0;
	}
}

/* ── Syntax Highlighting ── */
.c-kw { color: var(--color-brand); font-weight: 500; }
.c-fn { color: #d9946e; }
.c-str { color: #7a9b6e; }
.c-prop { color: var(--color-text-primary); }
.c-comment { color: var(--color-text-tertiary); }
</style>
