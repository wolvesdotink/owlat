<script setup lang="ts">
/**
 * The company and tasks of the open conversation (CompanyContextPanel), placed
 * by the reader pane's width rather than the viewport's, the way the Team
 * discussion is: the same reader renders in panes of any size.
 *
 *   - From 60rem of pane width, a 20rem rail beside the conversation, sticky
 *     under the back bar. Collapsed, it shrinks to a strip with one button.
 *   - Narrower (a phone, a reader pane beside a wide list, Zen), a section
 *     under the conversation in the reader's own measure. Collapsed, only its
 *     heading stays.
 *
 * The collapse is one persisted choice (usePostboxContextRail) for both
 * placements.
 */
import type { Id } from '@owlat/api/dataModel';
import CompanyContextPanel from '~/components/companies/CompanyContextPanel.vue';
import { usePostboxContextRail } from '~/composables/postbox/usePostboxContextRail';
import { ChevronDownIcon, PanelRightCloseIcon, PanelRightOpenIcon } from '@coolicons/vue';

defineProps<{ threadId: string }>();

const { t } = useI18n();
const { collapsed, toggle } = usePostboxContextRail();
const bodyId = useId();
const headingId = useId();
</script>

<template>
	<aside
		class="pbx-context-rail mx-auto max-w-4xl px-6 pb-8 @min-[60rem]:sticky @min-[60rem]:top-(--pbx-reader-sticky-top) @min-[60rem]:mx-0 @min-[60rem]:max-h-[calc(100vh_-_var(--shell-chrome-h,4rem)_-_var(--pbx-reader-sticky-top,0px))] @min-[60rem]:max-w-none @min-[60rem]:shrink-0 @min-[60rem]:self-start @min-[60rem]:overflow-y-auto @min-[60rem]:border-l @min-[60rem]:border-border-subtle @min-[60rem]:py-6"
		:class="
			collapsed ? '@min-[60rem]:w-12 @min-[60rem]:px-2' : '@min-[60rem]:w-80 @min-[60rem]:px-4'
		"
		:aria-labelledby="headingId"
		data-testid="postbox-context-rail"
		:data-collapsed="collapsed ? 'true' : 'false'"
	>
		<div
			class="flex items-center gap-2 border-t border-border-subtle pt-4 @min-[60rem]:border-t-0 @min-[60rem]:pt-0"
			:class="collapsed ? '@min-[60rem]:justify-center' : ''"
		>
			<h2
				:id="headingId"
				class="flex-1 text-2xs font-medium uppercase tracking-wider text-text-tertiary"
				:class="{ '@min-[60rem]:sr-only': collapsed }"
			>
				{{ t('components.companies.rail.title') }}
			</h2>
			<UiTooltip
				:text="
					collapsed ? t('components.companies.rail.show') : t('components.companies.rail.hide')
				"
			>
				<button
					type="button"
					class="rounded p-1 text-text-tertiary outline-none hover:bg-bg-surface-hover hover:text-text-primary focus-visible:ring-1 focus-visible:ring-brand/40"
					:aria-expanded="!collapsed"
					:aria-controls="bodyId"
					:aria-label="
						collapsed ? t('components.companies.rail.show') : t('components.companies.rail.hide')
					"
					data-testid="postbox-context-rail-toggle"
					@click="toggle"
				>
					<ChevronDownIcon
						class="h-4 w-4 transition-transform duration-(--motion-fast) @min-[60rem]:hidden"
						:class="{ '-rotate-90': collapsed }"
						aria-hidden="true"
					/>
					<component
						:is="collapsed ? PanelRightOpenIcon : PanelRightCloseIcon"
						class="hidden h-4 w-4 @min-[60rem]:block"
						aria-hidden="true"
					/>
				</button>
			</UiTooltip>
		</div>
		<div v-show="!collapsed" :id="bodyId" class="mt-3">
			<CompanyContextPanel :mail-thread-id="threadId as Id<'mailThreads'>" />
		</div>
	</aside>
</template>
