<script setup lang="ts">
// Renders inside <DarkSection> — the .lp-dark wrapper re-points the shared
// color tokens, so text-text-* / border-border-* utilities resolve to the
// white scales here.
const { t } = useI18n();

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
	<div
		id="developers"
		ref="target"
		class="px-12 max-md:px-6 py-20 max-md:py-14"
		:class="{ visible: isVisible }"
	>
		<div class="grid grid-cols-[5fr_7fr] gap-16 items-center max-lg:grid-cols-1 max-lg:gap-12">
			<!-- Left: Copy -->
			<div>
				<span class="dev-el lp-eyebrow mb-4" style="--i: 0">{{ t('developers.eyebrow') }}</span>
				<I18nT
					keypath="developers.title"
					tag="h2"
					class="dev-el lp-title mb-4"
					style="--i: 1"
					scope="global"
				>
					<template #break><br class="max-md:hidden" /></template>
					<template #accent>
						<span class="lp-title-accent">{{ t('developers.titleAccent') }}</span>
					</template>
				</I18nT>
				<p
					class="dev-el text-base text-text-secondary leading-relaxed max-w-[540px] mb-8"
					style="--i: 2"
				>
					{{ t('developers.intro') }}
				</p>

				<div class="dev-el flex gap-5" style="--i: 3">
					<a
						href="https://docs.owlat.app/api/sdk"
						class="group inline-flex items-center gap-1.5 text-caption font-medium text-brand hover:text-brand-hover transition-colors duration-(--motion-fast) no-underline"
					>
						<span>{{ t('developers.sdkReference') }}</span>
						<svg
							class="transition-transform duration-(--motion-fast) group-hover:translate-x-[3px]"
							width="13"
							height="13"
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
					<a
						href="https://docs.owlat.app/api/"
						class="group inline-flex items-center gap-1.5 text-caption font-medium text-brand hover:text-brand-hover transition-colors duration-(--motion-fast) no-underline"
					>
						<span>{{ t('developers.apiDocs') }}</span>
						<svg
							class="transition-transform duration-(--motion-fast) group-hover:translate-x-[3px]"
							width="13"
							height="13"
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
			</div>

			<!-- Right: Terminal window -->
			<div class="dev-code">
				<div
					class="rounded-2xl border border-border-subtle overflow-hidden"
					style="background: rgba(255, 255, 255, 0.03)"
				>
					<!-- Header: dots + tabs + copy -->
					<div class="flex items-center gap-1 px-3 py-2 border-b border-border-subtle">
						<div class="flex items-center gap-1.5 pl-1 pr-3" aria-hidden="true">
							<span
								v-for="i in 3"
								:key="i"
								class="w-[7px] h-[7px] rounded-full"
								style="background: rgba(255, 255, 255, 0.14)"
							/>
						</div>
						<button
							v-for="tab in ['sdk', 'curl'] as const"
							:key="tab"
							class="px-3 py-1.5 font-mono text-[0.625rem] font-medium tracking-[0.04em] uppercase cursor-pointer transition-colors duration-(--motion-fast) border-none rounded-md bg-transparent"
							:class="
								activeTab === tab
									? 'text-text-primary bg-white/10'
									: 'text-text-tertiary hover:text-text-secondary'
							"
							@click="activeTab = tab"
						>
							{{ tab === 'sdk' ? t('developers.tabSdk') : t('developers.tabCurl') }}
						</button>
						<button
							class="ml-auto flex items-center gap-1.5 px-2 py-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-white/10 transition-colors duration-(--motion-fast) cursor-pointer border-none bg-transparent"
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
								aria-hidden="true"
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
								aria-hidden="true"
							>
								<path d="M20 6 9 17l-5-5" />
							</svg>
							<span class="text-[0.6rem] font-medium font-mono">{{
								copied ? t('developers.copied') : t('developers.copy')
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
	</div>
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
