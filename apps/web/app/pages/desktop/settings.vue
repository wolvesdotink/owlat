<script setup lang="ts">
/**
 * Redirect. Desktop settings live in Preferences now.
 *
 * This was a 441-line standalone page with `layout: false`, its own titlebar and
 * its own back link, sitting outside `/dashboard` and duplicating the appearance
 * and notification controls that also lived in Preferences. It is now
 * `/dashboard/preferences/device` ("This device"), inside the Preferences
 * layout. The route survives because the native application menu, deep links and
 * anyone's muscle memory still point here.
 *
 * With no workspace connected there is no dashboard to redirect INTO, so that
 * case goes to the connect flow instead. The route stays allow-listed in
 * `middleware/desktop-workspace.global.ts` so this page gets to make that
 * decision rather than being bounced before it renders.
 */
definePageMeta({
	layout: false,
});

const { active } = useDesktopWorkspaces();

await navigateTo(active.value ? '/dashboard/preferences/device' : '/desktop/welcome', {
	replace: true,
});
</script>

<template>
	<div class="flex min-h-screen items-center justify-center bg-bg-deep">
		<Icon name="lucide:loader-2" class="size-5 animate-spin motion-reduce:animate-none text-text-tertiary" />
	</div>
</template>
