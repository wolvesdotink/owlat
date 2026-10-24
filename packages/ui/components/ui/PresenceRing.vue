<script setup lang="ts">
/**
 * "Here right now" halo around an avatar: wraps the default slot in the shared
 * `.ui-presence-ring` (assets/css/motion.css) and registers the pulsing glow
 * with the shared visibility observer, so a halo scrolled out of a long list or
 * left in a background tab stops pulsing.
 *
 * `active` false renders the same wrapper without the ring, for a slot whose
 * person may or may not be present (a team-inbox row's assignee), so the
 * avatar does not remount when presence changes.
 */
import { ref } from 'vue';
import { useVisibleAnimation } from '../../composables/useVisibleAnimation';

const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true });

const root = ref<HTMLElement | null>(null);
useVisibleAnimation(root, () => props.active);
</script>

<template>
	<span ref="root" :class="active ? 'ui-presence-ring' : undefined">
		<slot />
	</span>
</template>
