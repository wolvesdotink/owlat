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
		setTimeout(() => {
			copied.value = false;
		}, 2000);
	} catch {}
}
</script>

<template>
	<section
		id="developers"
		ref="target"
		class="px-8 max-md:px-6 py-28 max-md:py-20 border-t border-border-subtle"
		:class="{ visible: isVisible }"
	>
		<div
			class="max-w-[1200px] mx-auto grid grid-cols-[5fr_7fr] gap-20 items-center max-lg:grid-cols-1 max-lg:gap-12"
		>
			<!-- Left: Copy -->
			<div>
				<span
					class="dev-el text-xs font-medium uppercase tracking-widest text-text-tertiary mb-4 block"
					style="--i: 0"
				>
					Developers
				</span>
				<h2
					class="dev-el text-[clamp(2rem,4.5vw,3.25rem)] font-semibold leading-[1.1] tracking-tight text-text-primary mb-4"
					style="--i: 1"
				>
					Ship with the SDK,<br class="max-md:hidden" />
					or stay in the dashboard
				</h2>
				<p
					class="dev-el text-base text-text-secondary leading-relaxed max-w-prose mb-8"
					style="--i: 2"
				>
					Send transactional emails, manage contacts, trigger automations, and track delivery with a
					single API call. Use the TypeScript SDK for type-safe integrations or hit the REST API
					directly from any language.
				</p>

				<div class="dev-el flex gap-5" style="--i: 3">
					<a
						href="https://docs.owlat.app/api/sdk"
						class="text-[0.8125rem] font-medium text-brand hover:text-brand-hover transition-colors duration-(--motion-fast) no-underline hover:underline underline-offset-4"
					>
						SDK Reference
					</a>
					<a
						href="https://docs.owlat.app/api/"
						class="text-[0.8125rem] font-medium text-brand hover:text-brand-hover transition-colors duration-(--motion-fast) no-underline hover:underline underline-offset-4"
					>
						API Docs
					</a>
				</div>
			</div>

			<!-- Right: Code window -->
			<div class="dev-code">
				<div
					class="code-window border border-border-subtle rounded-(--radius-card) overflow-hidden"
					style="background: var(--surface-2); box-shadow: var(--shadow-2)"
				>
					<!-- Header: tabs + copy -->
					<div class="flex items-center gap-1 px-3 py-2 border-b border-border-subtle">
						<button
							v-for="tab in ['sdk', 'curl'] as const"
							:key="tab"
							class="px-3 py-1.5 font-mono text-[0.625rem] font-medium tracking-[0.04em] uppercase cursor-pointer transition-colors duration-(--motion-fast) border-none rounded-md bg-transparent"
							:class="
								activeTab === tab
									? 'text-text-primary bg-bg-surface'
									: 'text-text-tertiary hover:text-text-secondary'
							"
							@click="activeTab = tab"
						>
							{{ tab === 'sdk' ? 'TypeScript SDK' : 'cURL' }}
						</button>
						<button
							class="ml-auto flex items-center gap-1.5 px-2 py-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-surface transition-colors duration-(--motion-fast) cursor-pointer border-none bg-transparent"
							:class="{ 'text-success!': copied }"
							@click="copyCode"
						>
							<svg
								v-if="!copied"
								width="13"
								height="13"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<rect x="9" y="9" width="13" height="13" rx="2" />
								<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
							</svg>
							<svg
								v-else
								width="13"
								height="13"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2.5"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path d="M20 6 9 17l-5-5" />
							</svg>
							<span class="text-[0.6rem] font-medium font-mono">{{
								copied ? 'Copied' : 'Copy'
							}}</span>
						</button>
					</div>

					<!-- Code content -->
					<!-- SDK code -->
					<pre
						v-if="activeTab === 'sdk'"
						class="px-5 py-5 m-0 overflow-x-auto font-mono text-[0.75rem] leading-[1.85] text-text-secondary"
					><code class="font-[inherit]"><span class="c-kw">import</span> { Owlat } <span class="c-kw">from</span> <span class="c-str">'@owlat/sdk-js'</span>

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
					<pre
						v-else
						class="px-5 py-5 m-0 overflow-x-auto font-mono text-[0.75rem] leading-[1.85] text-text-secondary"
					><code class="font-[inherit]"><span class="c-comment"># Send a transactional email</span>
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
				</div>
			</div>
		</div>
	</section>
</template>

<style scoped>
/* === Entry reveal: opacity + small translateY only === */
.dev-el,
.dev-code {
	opacity: 0;
	transform: translateY(8px);
	transition:
		opacity var(--motion-moderate) var(--ease-spring),
		transform var(--motion-moderate) var(--ease-spring);
	transition-delay: calc(var(--i, 0) * 0.05s);
}

.dev-code {
	transition-delay: 0.1s;
}

.visible .dev-el,
.visible .dev-code {
	opacity: 1;
	transform: none;
}
</style>
