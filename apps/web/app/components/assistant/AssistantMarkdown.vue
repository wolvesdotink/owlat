<script setup lang="ts">
import { parseMarkdown } from '~/utils/markdown';

const props = defineProps<{ source: string }>();
const blocks = computed(() => parseMarkdown(props.source));

const headingClass: Record<number, string> = {
	1: 'text-lg font-semibold mt-1',
	2: 'text-base font-semibold mt-1',
	3: 'text-sm font-semibold mt-1',
	4: 'text-sm font-semibold',
	5: 'text-sm font-semibold',
	6: 'text-sm font-semibold',
};
</script>

<template>
	<div class="assistant-md text-sm leading-relaxed text-text-primary space-y-2 break-words">
		<template v-for="(block, bi) in blocks" :key="bi">
			<component
				:is="`h${block.level}`"
				v-if="block.type === 'heading'"
				:class="headingClass[block.level] ?? 'text-sm font-semibold'"
			>
				<AssistantInline :inlines="block.inlines" />
			</component>

			<p v-else-if="block.type === 'paragraph'">
				<AssistantInline :inlines="block.inlines" />
			</p>

			<pre
				v-else-if="block.type === 'code'"
				class="overflow-x-auto rounded-lg bg-bg-surface border border-border-subtle p-3 text-xs font-mono leading-relaxed"
			><code>{{ block.value }}</code></pre>

			<ul v-else-if="block.type === 'list' && !block.ordered" class="list-disc pl-5 space-y-1">
				<li v-for="(item, ii) in block.items" :key="ii"><AssistantInline :inlines="item" /></li>
			</ul>

			<ol v-else-if="block.type === 'list' && block.ordered" class="list-decimal pl-5 space-y-1">
				<li v-for="(item, ii) in block.items" :key="ii"><AssistantInline :inlines="item" /></li>
			</ol>

			<blockquote
				v-else-if="block.type === 'blockquote'"
				class="border-l-2 border-border-subtle pl-3 text-text-secondary italic"
			>
				<AssistantInline :inlines="block.inlines" />
			</blockquote>

			<hr v-else-if="block.type === 'hr'" class="border-border-subtle" />
		</template>
	</div>
</template>
