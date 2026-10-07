<script setup lang="ts">
/**
 * One block of the brief: the small uppercase heading with an optional note
 * on the right, then the content. Blocks after the first are separated by a
 * hairline, as in the plan's mockup.
 */
defineProps<{
	title: string;
	/** Right-aligned note ("4 open", "Jonas · today 09:12"). */
	note?: string;
	headingId?: string;
}>();
</script>

<template>
	<section
		class="brief-section"
		:aria-labelledby="headingId"
	>
		<h3
			:id="headingId"
			class="mb-1.5 flex items-center gap-2 text-2xs font-medium uppercase tracking-wider text-text-tertiary"
		>
			{{ title }}
			<slot name="badge" />
			<span v-if="note || $slots.note" class="ml-auto text-xs font-normal normal-case tracking-normal">
				<slot name="note">{{ note }}</slot>
			</span>
		</h3>
		<slot />
	</section>
</template>

<style scoped>
.brief-section + .brief-section {
	margin-top: 1rem;
	padding-top: 0.875rem;
	border-top: 1px solid var(--color-border-subtle);
}
</style>
