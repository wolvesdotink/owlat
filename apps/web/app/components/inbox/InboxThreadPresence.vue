<script setup lang="ts">
/**
 * Shared-inbox thread presence surface — "who else is here".
 *
 * Purely presentational: the parent page owns the useThreadPresence lifecycle
 * (heartbeat + editor-focus mode) and passes the resolved people in. Renders two
 * quiet, depth-on-demand hints per the Focus Inbox brief:
 *  1. an avatar stack of everyone currently on the thread, each wrapped in a
 *     softly-pulsing success ring (CSS-only; static under prefers-reduced-motion);
 *  2. a one-line warning-subtle banner when a teammate is actively replying, so
 *     you don't quietly double-answer — the b3b piece adds the send-time guard.
 *
 * Weight-based, no large fills: the ring is a 1.5px success indicator, the banner
 * is muted. Human language only — "… is replying to this thread right now."
 */
export interface PresencePerson {
	userId: string;
	mode: 'viewing' | 'replying';
	name: string;
	image?: string | null;
}

const props = defineProps<{
	/** Everyone present except the current user, already resolved to names. */
	people: PresencePerson[];
}>();

const MAX_AVATARS = 4;
const shownPeople = computed(() => props.people.slice(0, MAX_AVATARS));
const overflow = computed(() => Math.max(0, props.people.length - MAX_AVATARS));

const repliers = computed(() => props.people.filter((p) => p.mode === 'replying'));

/** "Jordan", "Jordan and Amir", "Jordan, Amir and 2 others". */
const replyingLabel = computed(() => {
	const names = repliers.value.map((p) => p.name);
	if (names.length === 0) return '';
	if (names.length === 1) return names[0]!;
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names[0]}, ${names[1]} and ${names.length - 2} other${names.length - 2 === 1 ? '' : 's'}`;
});

const replyingVerb = computed(() => (repliers.value.length === 1 ? 'is replying' : 'are replying'));
</script>

<template>
	<div v-if="people.length > 0" class="flex flex-col gap-2">
		<!-- Avatar stack: everyone currently on the thread, pulsing success ring. -->
		<div class="flex items-center gap-2">
			<div class="flex -space-x-1.5">
				<span
					v-for="person in shownPeople"
					:key="person.userId"
					class="ui-presence-ring"
					:title="`${person.name} is ${person.mode === 'replying' ? 'replying' : 'viewing'}`"
				>
					<UiAvatar :name="person.name" :image="person.image" size="sm" deterministic-color />
				</span>
				<span
					v-if="overflow > 0"
					class="w-6 h-6 rounded-full border border-border-subtle bg-bg-surface text-text-tertiary text-[0.625rem] font-medium flex items-center justify-center"
					:title="`${overflow} more here`"
				>
					+{{ overflow }}
				</span>
			</div>
			<span class="text-xs text-text-tertiary">
				{{ people.length === 1 ? '1 person here' : `${people.length} people here` }}
			</span>
		</div>

		<!-- Replying banner — quiet, warning-subtle, human language. -->
		<div
			v-if="repliers.length > 0"
			class="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-text-secondary presence-banner"
		>
			<Icon name="lucide:pencil-line" class="w-3.5 h-3.5 text-warning shrink-0" />
			<span>
				<span class="font-medium text-text-primary">{{ replyingLabel }}</span>
				{{ replyingVerb }} to this thread right now.
			</span>
		</div>
	</div>
</template>

<style scoped>
/*
 * The pulsing "here now" avatar ring is the shared `.ui-presence-ring` utility
 * (packages/ui motion.css) so this surface and the team-inbox row never drift.
 */
.presence-banner {
	background-color: var(--color-warning-subtle);
}
</style>
