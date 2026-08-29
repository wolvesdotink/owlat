<script setup lang="ts">
/**
 * The folder rail's VIRTUAL views: Reply Queue, Snoozed, Files, Subscriptions.
 *
 * None of these is a folder. Opening one moves no message and changes no row —
 * each is a second way into mail the mailbox already holds, which is why they
 * render as a group below the real folders and above the secondary
 * destinations, and why they are one component rather than four call sites in
 * the rail. Split out of `PostboxFolderRail.vue` for the ~500 LOC ratchet.
 *
 * Collapsed, the rail is a ~48px icon strip: every link loses its label, so the
 * name has to survive as `title` + `aria-label` or the strip is unusable with a
 * screen reader. The Reply Queue count moves from an inline number to a corner
 * badge for the same reason.
 */
defineProps<{
	/** Rail is the narrow icon strip. */
	collapsed: boolean;
	/** Active folder role, so Snoozed can mark itself current. */
	folderRole: string;
	/** Threads waiting on a reply; `0` hides the badge entirely. */
	replyQueueCount: number;
}>();

const { t } = useI18n();
</script>

<template>
<!-- Reply Queue — AI task list of emails waiting on a reply (virtual
     view like Snoozed; threads stay in their folders). -->
<NuxtLink
	to="/dashboard/postbox/reply-queue"
	class="rounded text-sm hover:bg-bg-surface"
	:class="
		collapsed
			? 'relative flex items-center justify-center w-9 h-9'
			: 'flex items-center gap-2 px-2.5 py-1.5'
	"
	:title="collapsed ? t('components.postbox.postboxFolderRail.replyQueue') : undefined"
	:aria-label="
		collapsed
			? replyQueueCount > 0
				? t('components.postbox.postboxFolderRail.replyQueueAriaLabel', {
						count: replyQueueCount,
					})
				: t('components.postbox.postboxFolderRail.replyQueue')
			: undefined
	"
>
	<Icon name="lucide:reply" class="w-4 h-4" />
	<template v-if="!collapsed">
		<span class="flex-1">{{ t('components.postbox.postboxFolderRail.replyQueue') }}</span>
		<span v-if="replyQueueCount > 0" class="text-xs font-medium text-text-secondary">{{
			replyQueueCount
		}}</span>
	</template>
	<span
		v-else-if="replyQueueCount > 0"
		class="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-text-primary text-text-inverse text-2xs leading-4 font-medium text-center"
		>{{ replyQueueCount > 99 ? '99+' : replyQueueCount }}</span
	>
</NuxtLink>

<!-- Virtual "Snoozed" view (no backing system folder; messages stay in
     their origin folder, hidden until the wakeup cron). -->
<NuxtLink
	to="/dashboard/postbox/snoozed"
	class="rounded text-sm hover:bg-bg-surface"
	:class="[
		collapsed
			? 'flex items-center justify-center w-9 h-9'
			: 'flex items-center gap-2 px-2.5 py-1.5',
		{ 'bg-bg-surface text-brand': folderRole === 'snoozed' },
	]"
	:title="collapsed ? t('components.postbox.postboxFolderRail.snoozed') : undefined"
	:aria-label="collapsed ? t('components.postbox.postboxFolderRail.snoozed') : undefined"
>
	<Icon name="lucide:clock" class="w-4 h-4" />
	<span v-if="!collapsed" class="flex-1">{{
		t('components.postbox.postboxFolderRail.snoozed')
	}}</span>
</NuxtLink>
<!-- Virtual "Files" view: the attachment index, browsable by type,
     sender and recency. Nothing moves — it is a second way into mail
     you already have, so it sits with the other virtual views. -->
<NuxtLink
	to="/dashboard/postbox/files"
	class="rounded text-sm hover:bg-bg-surface"
	:class="
		collapsed
			? 'flex items-center justify-center w-9 h-9'
			: 'flex items-center gap-2 px-2.5 py-1.5'
	"
	:title="collapsed ? t('components.postbox.postboxFolderRail.files') : undefined"
	:aria-label="collapsed ? t('components.postbox.postboxFolderRail.files') : undefined"
>
	<Icon name="lucide:paperclip" class="w-4 h-4" />
	<span v-if="!collapsed" class="flex-1">{{
		t('components.postbox.postboxFolderRail.files')
	}}</span>
</NuxtLink>
<!-- Virtual "Subscriptions" view: every inbox sender that ships a
     List-Unsubscribe target, with the batch unsubscribe verb. Nothing
     moves until the user acts, so it sits with the other virtual views. -->
<NuxtLink
	to="/dashboard/postbox/subscriptions"
	class="rounded text-sm hover:bg-bg-surface"
	:class="
		collapsed
			? 'flex items-center justify-center w-9 h-9'
			: 'flex items-center gap-2 px-2.5 py-1.5'
	"
	:title="collapsed ? t('components.postbox.postboxFolderRail.subscriptions') : undefined"
	:aria-label="
		collapsed ? t('components.postbox.postboxFolderRail.subscriptions') : undefined
	"
>
	<Icon name="lucide:bell-off" class="w-4 h-4" />
	<span v-if="!collapsed" class="flex-1">{{
		t('components.postbox.postboxFolderRail.subscriptions')
	}}</span>
</NuxtLink>
</template>
