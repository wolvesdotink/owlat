<script setup lang="ts">
/**
 * The admin desktop-updates page's list of cached releases, newest first, with
 * the GitHub body behind a disclosure (the same shape the system page uses for
 * its notes). Empty, it offers the same "Check now" the page header does.
 */
import type { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import { formatDateTime } from '~/utils/formatters';
import { releaseLineKey } from '~/composables/useDesktopUpdatePolicy';

type CachedRelease = FunctionReturnType<typeof api.desktop.updates.listReleases>[number];

defineProps<{ releases: CachedRelease[]; checking: boolean; canManage: boolean }>();
const emit = defineEmits<{ check: [] }>();

const { t } = useI18n();
</script>

<template>
	<section class="card p-5">
		<h2 class="text-base font-semibold text-text-primary">
			{{ t('dashboard.admin.instance.desktopUpdates.releases.title') }}
		</h2>

		<UiEmptyState
			v-if="releases.length === 0"
			class="mt-2"
			icon="lucide:monitor-down"
			:title="t('dashboard.admin.instance.desktopUpdates.empty.title')"
			:description="t('dashboard.admin.instance.desktopUpdates.empty.description')"
			data-testid="desktop-updates-empty"
		>
			<UiButton
				variant="outline"
				size="sm"
				:loading="checking"
				:disabled="!canManage"
				data-testid="desktop-updates-empty-check"
				@click="emit('check')"
			>
				{{ t('dashboard.admin.instance.desktopUpdates.checkNow') }}
			</UiButton>
		</UiEmptyState>

		<table v-else class="mt-3 w-full text-sm" data-testid="desktop-updates-releases">
			<thead>
				<tr class="text-left text-xs uppercase tracking-wider text-text-tertiary">
					<th class="py-2 font-medium">
						{{ t('dashboard.admin.instance.desktopUpdates.releases.version') }}
					</th>
					<th class="py-2 font-medium">
						{{ t('dashboard.admin.instance.desktopUpdates.releases.line') }}
					</th>
					<th class="py-2 font-medium">
						{{ t('dashboard.admin.instance.desktopUpdates.releases.published') }}
					</th>
				</tr>
			</thead>
			<tbody>
				<tr
					v-for="release in releases"
					:key="release.tag"
					class="border-t border-border-subtle align-top"
					:data-testid="`desktop-updates-release-${release.version}`"
				>
					<td class="py-2 font-mono text-text-primary">
						{{ release.version }}
						<span v-if="release.isPrerelease" class="ml-1 text-xs text-text-tertiary">
							{{ t('dashboard.admin.instance.desktopUpdates.releases.prerelease') }}
						</span>
					</td>
					<td class="py-2 text-text-secondary">{{ t(releaseLineKey(release.line)) }}</td>
					<td class="py-2 text-text-secondary">
						{{ formatDateTime(release.publishedAt) }}
						<details v-if="release.notes" class="mt-1">
							<summary
								class="text-xs font-medium text-text-primary cursor-pointer hover:text-brand"
							>
								{{ t('dashboard.admin.instance.desktopUpdates.releases.notes') }}
							</summary>
							<pre
								class="mt-2 text-xs text-text-secondary whitespace-pre-wrap font-sans leading-relaxed"
								>{{ release.notes }}</pre>
						</details>
					</td>
				</tr>
			</tbody>
		</table>
	</section>
</template>
