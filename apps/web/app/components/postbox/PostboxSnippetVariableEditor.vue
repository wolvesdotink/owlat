<script setup lang="ts">
/**
 * Declare what a snippet's `{{tokens}}` mean (plan idea 13).
 *
 * The rows are DRIVEN BY THE BODY, not by a separate list the author maintains:
 * every token typed into the snippet gets a row, and a token deleted from the
 * text takes its row with it. That way a declaration can never outlive the
 * token it describes, and there is no way to declare a variable the snippet
 * does not use.
 *
 * An undeclared token still resolves through the composer's implicit name table
 * (`{{firstName}}` and friends), so this panel is entirely optional — it exists
 * to name the ones that table cannot guess, above all `prompt`, which asks the
 * person inserting the snippet.
 */
import {
	SNIPPET_VARIABLE_SOURCES,
	snippetTokens,
	snippetVariableSourceKey,
	type SnippetVariable,
	type SnippetVariableSource,
} from '~/utils/postboxSnippetVariables';

const props = defineProps<{ bodyHtml: string }>();

const variables = defineModel<SnippetVariable[]>({ required: true });

const { t } = useI18n();

const tokens = computed(() => snippetTokens(props.bodyHtml));

function declarationFor(token: string): SnippetVariable | undefined {
	return variables.value.find((v) => v.token === token);
}

/**
 * Render a token the way it appears in the snippet body.
 *
 * This lives in the script block on purpose: the braces cannot be built inline
 * in the template, because the Vue tokenizer closes the interpolation on the
 * first `}}` it meets and the production build fails to parse the leftovers.
 */
function tokenLiteral(token: string): string {
	return `{{${token}}}`;
}

/** An empty selection is "let the composer guess" — i.e. no declaration at all. */
function setSource(token: string, source: SnippetVariableSource | '') {
	const existing = declarationFor(token);
	const rest = variables.value.filter((v) => v.token !== token);
	if (!source) {
		variables.value = rest;
		return;
	}
	const label = existing?.label;
	variables.value = [...rest, label ? { token, source, label } : { token, source }];
}

function setLabel(token: string, label: string) {
	const existing = declarationFor(token);
	if (!existing) return;
	variables.value = variables.value.map((v) => (v.token === token ? { ...v, label } : v));
}
</script>

<template>
	<section v-if="tokens.length > 0" class="rounded border border-border-subtle p-3 space-y-2">
		<h3 class="text-sm font-medium text-text-primary">
			{{ t('components.postbox.postboxSnippetVariableEditor.title') }}
		</h3>
		<p class="text-xs text-text-tertiary">
			{{ t('components.postbox.postboxSnippetVariableEditor.hint') }}
		</p>
		<div v-for="token in tokens" :key="token" class="flex flex-wrap items-center gap-2">
			<code class="rounded bg-bg-surface px-1.5 py-0.5 font-mono text-xs text-text-secondary">
				{{ tokenLiteral(token) }}
			</code>
			<select
				class="input w-56 text-sm"
				:value="declarationFor(token)?.source ?? ''"
				:aria-label="t('components.postbox.postboxSnippetVariableEditor.sourceLabel', { token })"
				@change="
					setSource(token, ($event.target as HTMLSelectElement).value as SnippetVariableSource | '')
				"
			>
				<option value="">
					{{ t('components.postbox.postboxSnippetVariableEditor.automatic') }}
				</option>
				<option v-for="source in SNIPPET_VARIABLE_SOURCES" :key="source" :value="source">
					{{ t(snippetVariableSourceKey(source)) }}
				</option>
			</select>
			<input
				v-if="declarationFor(token)?.source === 'prompt'"
				type="text"
				class="input flex-1 min-w-[12rem] text-sm"
				:value="declarationFor(token)?.label ?? ''"
				:placeholder="t('components.postbox.postboxSnippetVariableEditor.promptPlaceholder')"
				:aria-label="t('components.postbox.postboxSnippetVariableEditor.promptLabel', { token })"
				@input="setLabel(token, ($event.target as HTMLInputElement).value)"
			/>
		</div>
	</section>
</template>
