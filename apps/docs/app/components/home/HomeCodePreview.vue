<script setup lang="ts">
/**
 * The home page's tabbed code window: the same send-and-subscribe flow in
 * TypeScript, Java and cURL. Reveal styling (`.reveal-item`) and the card's
 * stagger come from the page.
 */
const activeTab = ref<'sdk' | 'java' | 'curl'>('sdk');

const tabFiles: Record<'sdk' | 'java' | 'curl', string> = {
	sdk: 'send.ts',
	java: 'Send.java',
	curl: 'terminal',
};
</script>

<template>
	<div class="code-window">
		<HomeWindowChrome :file="tabFiles[activeTab]" centered>
			<div class="code-tabs">
				<button :class="['code-tab', { active: activeTab === 'sdk' }]" @click="activeTab = 'sdk'">
					TypeScript
				</button>
				<button :class="['code-tab', { active: activeTab === 'java' }]" @click="activeTab = 'java'">
					Java
				</button>
				<button :class="['code-tab', { active: activeTab === 'curl' }]" @click="activeTab = 'curl'">
					cURL
				</button>
			</div>
		</HomeWindowChrome>

		<div class="code-body">
			<Transition name="code-fade" mode="out-in">
				<HomeCodeSample :key="activeTab" :sample="activeTab" />
			</Transition>
		</div>
	</div>
</template>

<style scoped>
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

@media (max-width: 580px) {
	.code-tabs {
		margin-left: auto;
	}
}
</style>
