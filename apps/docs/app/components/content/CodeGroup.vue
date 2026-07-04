<script setup lang="ts">
const activeTab = ref(0)
const tabs = ref<string[]>([])
const container = ref<HTMLElement | null>(null)

function syncTabs() {
	if (!container.value) return
	const blocks = container.value.querySelectorAll('pre')
	const names: string[] = []

	blocks.forEach((block, i) => {
		const filename = block.getAttribute('data-filename')
		const language = block.getAttribute('data-language')
		const langClass = block.className.match(/language-(\w+)/)
		names.push(filename || language || langClass?.[1] || `Tab ${i + 1}`)
	})

	tabs.value = names
	updateVisibility()
}

function updateVisibility() {
	if (!container.value) return
	const children = Array.from(container.value.children) as HTMLElement[]
	let blockIndex = 0
	children.forEach((child) => {
		if (child.classList.contains('code-group-tabs')) return
		// Skip Vue comment nodes
		if (child.nodeType !== 1) return
		child.style.display = blockIndex === activeTab.value ? '' : 'none'
		blockIndex++
	})
}

watch(activeTab, updateVisibility)

onMounted(() => {
	nextTick(syncTabs)
})
</script>

<template>
	<div ref="container" class="code-group">
		<div class="code-group-tabs">
			<button
				v-for="(tab, i) in tabs"
				:key="i"
				class="code-group-tab"
				:class="{ active: activeTab === i }"
				@click="activeTab = i"
			>
				{{ tab }}
			</button>
		</div>
		<slot />
	</div>
</template>

<style scoped>
.code-group {
	margin: 1.5rem 0;
	border: 1px solid var(--color-border-default);
	border-radius: 10px;
	overflow: hidden;
	transition: border-color var(--motion-moderate) var(--ease-spring), box-shadow var(--motion-moderate) var(--ease-spring);
}

.code-group:hover {
	border-color: color-mix(in oklab, var(--color-brand) 20%, var(--color-border-default));
	box-shadow: 0 0 20px rgba(196, 120, 90, 0.03);
}

.code-group-tabs {
	display: flex;
	gap: 0;
	background: var(--color-bg-soft);
	border-bottom: 1px solid var(--color-border-default);
	padding: 0 4px;
	overflow-x: auto;
}

.code-group-tab {
	appearance: none;
	border: none;
	background: none;
	padding: 10px 16px;
	font-family: var(
		--font-mono,
		ui-monospace,
		SFMono-Regular,
		Menlo,
		Monaco,
		Consolas,
		monospace
	);
	font-size: 0.75rem;
	color: var(--color-text-tertiary);
	cursor: pointer;
	white-space: nowrap;
	border-bottom: 2px solid transparent;
	margin-bottom: -1px;
	transition:
		color 0.15s,
		border-color 0.15s;
}

.code-group-tab:hover {
	color: var(--color-text-secondary);
}

.code-group-tab.active {
	color: var(--color-brand);
	border-bottom-color: var(--color-brand);
}

.code-group :deep(pre) {
	margin: 0;
	border: none;
	border-radius: 0;
}
</style>
