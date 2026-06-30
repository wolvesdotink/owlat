<script setup lang="ts">
/**
 * Slack-style workspace rail for the desktop app. Renders one avatar per
 * connected owlat instance; clicking switches (reloads into that workspace),
 * "+" opens the connect screen. Desktop-only — the parent gates with `isDesktop`.
 */
const { workspaces, activeId, switchTo } = useDesktopWorkspaces();
const { badgeFor } = useWorkspaceBadges();

function initials(label: string): string {
	return label
		.replace(/^https?:\/\//, '')
		.split(/[\s.]+/)
		.map((p) => p[0])
		.filter(Boolean)
		.join('')
		.toUpperCase()
		.slice(0, 2);
}
</script>

<template>
	<div
		v-if="workspaces.length"
		class="flex items-center gap-2 overflow-x-auto px-3 py-2 border-b border-border-subtle"
	>
		<button
			v-for="ws in workspaces"
			:key="ws.id"
			:title="ws.label"
			class="relative h-9 w-9 flex-shrink-0 rounded-lg text-xs font-semibold flex items-center justify-center transition-colors"
			:class="
				ws.id === activeId
					? 'bg-brand text-white'
					: 'bg-bg-base text-text-secondary hover:text-text-primary'
			"
			@click="switchTo(ws.id)"
		>
			{{ initials(ws.label) }}
			<span
				v-if="badgeFor(ws.id) > 0"
				class="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-red-500 text-[10px] text-white flex items-center justify-center"
			>
				{{ badgeFor(ws.id) > 99 ? '99+' : badgeFor(ws.id) }}
			</span>
		</button>

		<NuxtLink
			to="/desktop/welcome"
			title="Add workspace"
			class="h-9 w-9 flex-shrink-0 rounded-lg bg-bg-base text-text-secondary hover:text-text-primary flex items-center justify-center"
		>
			<Icon name="lucide:plus" class="w-4 h-4" />
		</NuxtLink>
	</div>
</template>
