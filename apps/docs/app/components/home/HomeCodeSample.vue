<script setup lang="ts">
/**
 * The home page's hand-highlighted SDK samples: the hero's quickstart and the
 * code preview's TypeScript, Java and cURL tabs. Rendered as a single `<pre>`
 * so the code preview can swap samples inside a `<Transition>`.
 */
defineProps<{
	sample: 'quickstart' | 'sdk' | 'java' | 'curl';
}>();
</script>

<template>
	<pre
		v-if="sample === 'quickstart'"
	><code><span class="c-kw">import</span> { Owlat } <span class="c-kw">from</span> <span class="c-str">'@owlat/sdk-js'</span>

<span class="c-kw">const</span> owlat = <span class="c-kw">new</span> <span class="c-fn">Owlat</span>(<span class="c-str">'lm_live_...'</span>)

<span class="c-kw">await</span> owlat.transactional.<span class="c-fn">send</span>({
  <span class="c-prop">email</span>: <span class="c-str">'mira@acme.io'</span>,
  <span class="c-prop">slug</span>:  <span class="c-str">'welcome-email'</span>,
  <span class="c-prop">dataVariables</span>: { <span class="c-prop">firstName</span>: <span class="c-str">'Mira'</span> }
})</code></pre>

	<!-- TypeScript -->
	<pre
		v-else-if="sample === 'sdk'"
	><code><span class="c-kw">import</span> { Owlat } <span class="c-kw">from</span> <span class="c-str">'@owlat/sdk-js'</span>

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
	<pre v-else-if="sample === 'java'"><code><span class="c-kw">import</span> com.owlat.sdk.Owlat;
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
	<pre v-else><code><span class="c-comment"># Send a transactional email</span>
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
</template>

<style scoped>
/* Scoped to the two hosts' bodies: they own padding and scrolling, the sample owns its type. */
.snippet-body pre,
.code-body pre {
	margin: 0;
	font-size: 13.5px;
	line-height: 1.7;
	font-family: var(--font-mono);
	color: var(--color-text-primary);
	white-space: pre;
}

/* ── Syntax Highlighting (tokenized via main.css — flips with color mode) ── */
.c-kw {
	color: var(--color-brand);
	font-weight: 500;
}
.c-fn {
	color: var(--color-syntax-fn);
}
.c-str {
	color: var(--color-syntax-str);
}
.c-prop {
	color: var(--color-text-primary);
}
.c-comment {
	color: var(--color-text-tertiary);
}
</style>
