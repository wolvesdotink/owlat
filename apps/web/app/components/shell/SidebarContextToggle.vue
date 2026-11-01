<script setup lang="ts">
/**
 * The sidebar shows one context at a time (Inbox ↔ Marketing) so it stays
 * focused on the current work. Emergent: only rendered while both contexts
 * survived the feature flags. Switching navigates to the target context's
 * last-visited route.
 */
import type { SidebarContext } from '~/lib/sidebarContext';
import { ChatConversationIcon, MegaphoneIcon } from '@coolicons/vue';
import { navIcon } from '~/lib/navIcons';

defineProps<{ collapsed: boolean; activeContext: SidebarContext }>();
const emit = defineEmits<{ switch: [context: SidebarContext] }>();

const { t } = useI18n();

// Frozen at setup, so `label` holds a MESSAGE KEY the template resolves rather
// than a sentence captured in whatever locale was active at mount.
const sidebarContexts = [
	{ key: 'inbox', label: 'shell.dashboard.contexts.inbox', icon: ChatConversationIcon },
	{ key: 'marketing', label: 'shell.dashboard.contexts.marketing', icon: MegaphoneIcon },
] as const;
</script>

<template>
	<div class="px-2 pt-3" role="group" :aria-label="t('shell.dashboard.sidebarContextGroup')">
		<div :class="collapsed ? 'flex flex-col gap-1' : 'flex gap-1'">
			<UiTooltip
				v-for="context in sidebarContexts"
				:key="context.key"
				:text="collapsed ? t(context.label) : undefined"
			>
				<button
					type="button"
					:aria-pressed="activeContext === context.key"
					:class="[
						'flex items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition-colors',
						collapsed ? 'p-2' : 'flex-1 px-2 py-1.5',
						activeContext === context.key
							? 'bg-(--surface-2-selected) text-text-primary'
							: 'text-text-secondary hover:text-text-primary hover:bg-(--surface-2-hover)',
					]"
					:aria-label="collapsed ? t(context.label) : undefined"
					@click="emit('switch', context.key)"
				>
					<component
						:is="navIcon(context.icon, activeContext === context.key)"
						:class="[
							collapsed ? 'w-5 h-5' : 'w-3.5 h-3.5',
							activeContext === context.key ? 'text-text-primary' : 'text-text-tertiary',
						]"
						size="1em"
					/>
					<span v-if="!collapsed">{{ t(context.label) }}</span>
				</button>
			</UiTooltip>
		</div>
	</div>
</template>
