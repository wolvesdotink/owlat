<script setup lang="ts">
/**
 * One block of the brief: the small uppercase heading with an optional note
 * on the right, then the content. Blocks after the first are separated by a
 * hairline, as in the plan's mockup.
 */
const props = defineProps<{
	title: string;
	/** Right-aligned note ("4 open", "Jonas · today 09:12"). */
	note?: string;
	headingId?: string;
}>();

// Two briefs can share a page (a reader beside a team-actions brief), so the
// caller's id is only a readable prefix: the instance id keeps it unique, and
// aria-labelledby never points into the other brief.
const uid = useId();
const resolvedHeadingId = computed(() =>
	props.headingId ? `${props.headingId}-${uid}` : `brief-section-${uid}`
);
</script>

<template>
	<section class="brief-section" :aria-labelledby="resolvedHeadingId">
		<!-- The badge and the note sit beside the heading, not in it: inside, they
		     would become part of the section's accessible name. -->
		<div class="mb-1.5 flex items-center gap-2">
			<h3
				:id="resolvedHeadingId"
				class="text-2xs font-medium uppercase tracking-wider text-text-tertiary"
			>
				{{ title }}
			</h3>
			<slot name="badge" />
			<span
				v-if="note || $slots['note']"
				class="ml-auto text-xs font-normal normal-case tracking-normal text-text-tertiary"
			>
				<slot name="note">{{ note }}</slot>
			</span>
		</div>
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
