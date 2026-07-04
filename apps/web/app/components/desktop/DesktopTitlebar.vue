<script setup lang="ts">
/**
 * Native-feel window titlebar for the desktop app. Renders nothing on web.
 *
 * macOS: the whole bar is a drag region and the native traffic lights sit over
 * the left gutter (see tauri.conf.json titleBarStyle/trafficLightPosition), so we
 * render only the owlat mark + active-workspace label.
 *
 * Windows/Linux: branded mark + label on the left (drag region) with custom
 * minimize / maximize / close controls on the right, driven through the
 * window.ts bridge. The native frame is removed in main.rs on these platforms.
 *
 * Interactive controls deliberately omit `data-tauri-drag-region` so clicks land
 * on them instead of starting a window drag.
 */
const { isDesktop, isMac } = useDesktopContext();
const { active } = useDesktopWorkspaces();

const title = computed(() => active.value?.label ?? 'Owlat');

async function control(fn: 'minimizeWindow' | 'toggleMaximizeWindow' | 'closeWindow') {
	try {
		const mod = await import('@owlat/desktop/src/window');
		await mod[fn]();
	} catch {
		// Not running inside Tauri.
	}
}
</script>

<template>
	<div
		v-if="isDesktop"
		data-tauri-drag-region
		class="desktop-titlebar fixed top-0 inset-x-0 z-[70] flex items-center h-[38px] border-b border-border-subtle bg-bg-elevated select-none"
		:class="isMac ? 'pl-[88px] pr-3' : 'pl-3'"
	>
		<!-- Brand + active workspace (draggable) -->
		<div class="flex items-center gap-2 min-w-0" data-tauri-drag-region>
			<img src="/owlat.svg" alt="" class="w-4 h-4 shrink-0" data-tauri-drag-region />
			<span
				class="font-display text-[13px] leading-none text-text-secondary truncate"
				data-tauri-drag-region
			>
				{{ title }}
			</span>
		</div>

		<!-- Windows/Linux window controls -->
		<div v-if="!isMac" class="ml-auto flex items-stretch self-stretch">
			<button type="button" class="tb-btn" aria-label="Minimize" @click="control('minimizeWindow')">
				<Icon name="lucide:minus" class="w-4 h-4" />
			</button>
			<button
				type="button"
				class="tb-btn"
				aria-label="Maximize"
				@click="control('toggleMaximizeWindow')"
			>
				<Icon name="lucide:square" class="w-3.5 h-3.5" />
			</button>
			<button
				type="button"
				class="tb-btn tb-close"
				aria-label="Close"
				@click="control('closeWindow')"
			>
				<Icon name="lucide:x" class="w-4 h-4" />
			</button>
		</div>
	</div>
</template>

<style scoped>
.tb-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 46px;
	height: 100%;
	color: var(--color-text-secondary);
	transition:
		background-color var(--motion-fast) var(--ease-spring),
		color var(--motion-fast) var(--ease-spring);
}
.tb-btn:hover {
	background-color: var(--color-bg-surface-hover);
	color: var(--color-text-primary);
}
/* Warm terracotta close affordance — on-brand, not the generic Windows red. */
.tb-close:hover {
	background-color: var(--color-error);
	color: #fff;
}
</style>
