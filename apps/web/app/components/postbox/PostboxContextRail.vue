<script setup lang="ts">
/**
 * The company and tasks of the open conversation (CompanyContextPanel) in a
 * 17.5rem rail beside it, sticky under the back bar, placed by the reader
 * pane's width rather than the viewport's: the same reader renders in panes
 * of any size. Collapsed, it shrinks to a strip with one button, a choice
 * remembered on this device (usePostboxContextRail).
 *
 * The rail needs 54rem of pane width (`pbx-pane`, PostboxReaderPane), which
 * leaves the conversation 36rem, above the 32rem under which message cards
 * wrap their sender row. Narrower, the rail is not rendered at all: the reader
 * shows the same panel as a one-line disclosure under the purpose header
 * (CompanyContextDisclosure), keyed to the same 54rem.
 */
import type { Id } from '@owlat/api/dataModel';
import CompanyContextPanel from '~/components/companies/CompanyContextPanel.vue';
import { usePostboxContextRail } from '~/composables/postbox/usePostboxContextRail';
import { PanelRightCloseIcon, PanelRightOpenIcon } from '@coolicons/vue';

defineProps<{ threadId: string }>();

const { t } = useI18n();
const { collapsed, toggle } = usePostboxContextRail();
const bodyId = useId();
const headingId = useId();
</script>

<template>
	<aside
		class="pbx-context-rail sticky top-(--pbx-reader-sticky-top) hidden max-h-[calc(100vh_-_var(--shell-chrome-h,4rem)_-_var(--pbx-reader-sticky-top,0px))] shrink-0 self-start overflow-y-auto border-l border-border-subtle py-6 @min-[54rem]/pbx-pane:block"
		:class="collapsed ? 'w-12 px-2' : 'w-70 px-4'"
		:aria-labelledby="headingId"
		data-testid="postbox-context-rail"
		:data-collapsed="collapsed ? 'true' : 'false'"
	>
		<div class="flex items-center gap-2" :class="collapsed ? 'justify-center' : ''">
			<h2
				:id="headingId"
				class="flex-1 text-2xs font-medium uppercase tracking-wider text-text-tertiary"
				:class="{ 'sr-only': collapsed }"
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
					<component
						:is="collapsed ? PanelRightOpenIcon : PanelRightCloseIcon"
						class="h-4 w-4"
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
