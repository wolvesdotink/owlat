<script setup lang="ts">
// What the API's rate limiting does and the headers it answers with.
import { CircleInfoIcon, GaugeIcon } from '@coolicons/vue';

const { t } = useI18n();
</script>

<template>
	<div class="card p-0 mb-6 overflow-hidden">
		<div class="px-6 py-4 border-b border-border-subtle bg-bg-surface/50">
			<div class="flex items-center gap-3">
				<GaugeIcon class="w-5 h-5 text-brand" />
				<h2 class="text-sm font-semibold text-text-primary">
					{{ t('dashboard.admin.team.api.index.rateLimit.title') }}
				</h2>
			</div>
		</div>
		<div class="p-6">
			<div class="grid gap-6 sm:grid-cols-2">
				<!-- Rate Limit -->
				<div class="flex items-start gap-4">
					<UiIconBox :icon="GaugeIcon" size="sm" variant="brand" rounded="lg" />
					<div>
						<p class="text-sm font-medium text-text-primary">
							{{ t('dashboard.admin.team.api.index.rateLimit.rate') }}
						</p>
						<p class="text-sm text-text-secondary mt-0.5">
							{{ t('dashboard.admin.team.api.index.rateLimit.rateDescription') }}
						</p>
					</div>
				</div>

				<!-- Response Headers -->
				<div class="flex items-start gap-4">
					<UiIconBox :icon="CircleInfoIcon" size="sm" variant="brand" rounded="lg" />
					<div>
						<p class="text-sm font-medium text-text-primary">
							{{ t('dashboard.admin.team.api.index.rateLimit.headersTitle') }}
						</p>
						<p class="text-sm text-text-secondary mt-0.5">
							{{ t('dashboard.admin.team.api.index.rateLimit.headersDescription') }}
						</p>
					</div>
				</div>
			</div>

			<!-- Headers Table -->
			<div class="mt-6 rounded-lg border border-border-subtle overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="bg-bg-surface">
							<th class="text-left px-4 py-2 text-text-secondary font-medium">
								{{ t('dashboard.admin.team.api.index.rateLimit.headerColumn') }}
							</th>
							<th class="text-left px-4 py-2 text-text-secondary font-medium">
								{{ t('common.description') }}
							</th>
						</tr>
					</thead>
					<tbody>
						<tr class="border-t border-border-subtle">
							<td class="px-4 py-2 whitespace-nowrap">
								<code class="text-xs font-mono text-brand bg-brand-subtle/50 px-1.5 py-0.5 rounded"
									>X-RateLimit-Limit</code
								>
							</td>
							<td class="px-4 py-2 text-text-secondary">
								{{ t('dashboard.admin.team.api.index.rateLimit.limitHeader') }}
							</td>
						</tr>
						<tr class="border-t border-border-subtle">
							<td class="px-4 py-2 whitespace-nowrap">
								<code class="text-xs font-mono text-brand bg-brand-subtle/50 px-1.5 py-0.5 rounded"
									>X-RateLimit-Remaining</code
								>
							</td>
							<td class="px-4 py-2 text-text-secondary">
								{{ t('dashboard.admin.team.api.index.rateLimit.remainingHeader') }}
							</td>
						</tr>
						<tr class="border-t border-border-subtle">
							<td class="px-4 py-2 whitespace-nowrap">
								<code class="text-xs font-mono text-brand bg-brand-subtle/50 px-1.5 py-0.5 rounded"
									>X-RateLimit-Reset</code
								>
							</td>
							<td class="px-4 py-2 text-text-secondary">
								{{ t('dashboard.admin.team.api.index.rateLimit.resetHeader') }}
							</td>
						</tr>
						<tr class="border-t border-border-subtle">
							<td class="px-4 py-2 whitespace-nowrap">
								<code class="text-xs font-mono text-warning bg-warning/10 px-1.5 py-0.5 rounded"
									>Retry-After</code
								>
							</td>
							<td class="px-4 py-2 text-text-secondary">
								{{ t('dashboard.admin.team.api.index.rateLimit.retryAfterHeader') }}
							</td>
						</tr>
					</tbody>
				</table>
			</div>

			<!-- Usage Example -->
			<div class="mt-4 p-4 rounded-lg bg-bg-deep border border-border-subtle">
				<p class="text-xs text-text-tertiary mb-2">
					{{ t('dashboard.admin.team.api.index.rateLimit.exampleHeaders') }}
				</p>
				<code class="text-xs font-mono text-text-secondary block leading-relaxed">
					X-RateLimit-Limit: 10<br />
					X-RateLimit-Remaining: 7<br />
					X-RateLimit-Reset: 1737158400
				</code>
			</div>
		</div>
	</div>
</template>
