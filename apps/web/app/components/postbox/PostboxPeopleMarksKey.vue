<script setup lang="ts">
/** The key to the People view's three marks, in the column's own small type. */
const { t } = useI18n();
</script>

<template>
	<span class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-text-tertiary">
		<span class="inline-flex items-center gap-1.5"
			><span aria-hidden="true" class="inline-flex"><PostboxPeopleMark :owed="1" size="sm" /></span
			>{{ t('components.postbox.people.column.legendWaiting') }}</span
		>
		<span class="inline-flex items-center gap-1.5"
			><span aria-hidden="true" class="inline-flex"
				><PostboxPeopleMark :may-owe="1" size="sm" /></span
			>{{ t('components.postbox.people.column.legendMaybe') }}</span
		>
		<span class="inline-flex items-center gap-1.5"
			><span aria-hidden="true" class="inline-flex"
				><PostboxPeopleMark :unread="1" size="sm" /></span
			>{{ t('components.postbox.people.column.legendUnread') }}</span
		>
	</span>
</template>
