<script setup lang="ts">
/**
 * <KnowledgeGraphStatsPanel> — the "insight layer" for the knowledge graph.
 *
 * Renders the member-visible analytics snapshot (`getGraphStats`, read once in
 * `useKnowledgeGraphView` and passed in here): god nodes, the confidence
 * histogram, approximate communities, and the most "surprising" connections. The
 * snapshot is already REDACTED server-side — cross-contact-disjoint edges are
 * stripped from `surprisingConnections` and only summarized as
 * `crossContactLinkCount`, surfaced here as a hidden-connections note. Clicking a
 * god node re-centers the canvas (emit `godNodeClick`).
 */
import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import { confidenceBucketBars } from '~/utils/knowledgeGraphLayout';
import { entryTypeIcon, relationLabel } from '~/utils/knowledgeEntryTypes';
import { ExternalLinkIcon, PackagesIcon, ShieldIcon, SparklesIcon, ZapIcon } from '@coolicons/vue';

type Snapshot = NonNullable<FunctionReturnType<typeof api.knowledge.graphAnalytics.getGraphStats>>;

const props = defineProps<{ stats: Snapshot | null }>();
const emit = defineEmits<{ godNodeClick: [entryId: string] }>();

const { t, te, locale } = useI18n();

// The relation types the panel can render, translated here: the shared
// presentation map (`~/utils/knowledgeEntryTypes`) stays a plain constant, so an
// unknown type still falls back to its raw label instead of a key path.
const relationTypeLabel = (type: string) => {
	const key = `components.knowledge.graphStatsPanel.relationTypes.${type}`;
	return te(key) ? t(key) : relationLabel(type);
};

const bars = computed(() => confidenceBucketBars(props.stats?.confidenceBuckets ?? []));
const percentFormatter = computed(
	() => new Intl.NumberFormat(locale.value, { style: 'percent', maximumFractionDigits: 0 })
);
const pct = (v: number) => percentFormatter.value.format(v);
const computedAtLabel = computed(() =>
	props.stats ? new Date(props.stats.computedAt).toLocaleString(locale.value) : ''
);
const maxCommunity = computed(() => Math.max(1, ...(props.stats?.communitySizes ?? [1])));
// The histogram and the community sizes are the "why" behind the summary, so
// they sit one click away instead of stacking up the sidebar.
const showDistribution = ref(false);
</script>

<template>
	<div v-if="!stats" class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5">
		<h3 class="text-sm font-semibold text-text-primary mb-1.5">
			{{ t('components.knowledge.graphStatsPanel.title') }}
		</h3>
		<p class="text-sm text-text-tertiary">
			{{ t('components.knowledge.graphStatsPanel.emptyBody') }}
		</p>
	</div>

	<div v-else class="space-y-4">
		<!-- Summary -->
		<div class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5">
			<div class="flex items-center justify-between mb-3">
				<h3 class="text-sm font-semibold text-text-primary">
					{{ t('components.knowledge.graphStatsPanel.title') }}
				</h3>
				<span
					v-if="stats.isTruncated"
					class="text-2xs uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-warning/10 text-warning"
					:title="t('components.knowledge.graphStatsPanel.approximateHint')"
				>
					{{ t('components.knowledge.graphStatsPanel.approximate') }}
				</span>
			</div>
			<div class="grid grid-cols-2 gap-3">
				<div>
					<p class="text-2xl font-bold text-text-primary">{{ stats.nodeCount }}</p>
					<p class="text-xs text-text-tertiary">
						{{ t('components.knowledge.graphStatsPanel.entries') }}
					</p>
				</div>
				<div>
					<p class="text-2xl font-bold text-text-primary">{{ stats.edgeCount }}</p>
					<p class="text-xs text-text-tertiary">
						{{ t('components.knowledge.graphStatsPanel.relations') }}
					</p>
				</div>
			</div>
			<p class="text-2xs text-text-tertiary mt-3">
				{{ t('components.knowledge.graphStatsPanel.computedAt', { timestamp: computedAtLabel }) }}
			</p>
		</div>

		<!-- God nodes -->
		<div class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5">
			<h3 class="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
				<ZapIcon class="w-4 h-4 text-brand" />
				{{ t('components.knowledge.graphStatsPanel.hubs') }}
			</h3>
			<div v-if="stats.godNodes.length === 0" class="text-sm text-text-tertiary">
				{{ t('components.knowledge.graphStatsPanel.noHubs') }}
			</div>
			<ul v-else class="space-y-1.5">
				<li
					v-for="g in stats.godNodes.slice(0, 8)"
					:key="g.entryId"
					class="flex items-center gap-2"
				>
					<button
						type="button"
						class="flex items-center gap-2 min-w-0 flex-1 text-left group"
						@click="emit('godNodeClick', g.entryId)"
					>
						<component
							:is="entryTypeIcon(g.entryType)"
							class="w-3.5 h-3.5 text-text-tertiary flex-shrink-0"
						/>
						<span
							class="text-sm text-text-primary truncate group-hover:text-brand transition-colors"
							:title="g.title"
						>
							{{ g.title }}
						</span>
					</button>
					<span
						class="text-2xs font-medium px-1.5 py-0.5 rounded-full bg-brand-subtle text-brand flex-shrink-0"
						:title="
							t('components.knowledge.graphStatsPanel.degreeHint', {
								incoming: g.inDegree,
								outgoing: g.outDegree,
							})
						"
					>
						{{ g.degree }}
					</span>
					<NuxtLink
						:to="`/dashboard/knowledge/${g.entryId}`"
						class="text-text-tertiary hover:text-brand transition-colors flex-shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						:aria-label="t('components.knowledge.graphStatsPanel.openEntry', { title: g.title })"
					>
						<ExternalLinkIcon class="w-3.5 h-3.5" aria-hidden="true" />
					</NuxtLink>
				</li>
			</ul>
		</div>

		<!-- Confidence histogram + communities, collapsed by default -->
		<div class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5">
			<UiDisclosure
				v-model="showDistribution"
				:label="t('components.knowledge.graphStatsPanel.distributionToggle')"
			>
				<h3 class="text-sm font-semibold text-text-primary mb-3">
					{{ t('components.knowledge.graphStatsPanel.confidenceTitle') }}
				</h3>
				<div class="flex items-end gap-1 h-24" role="list">
					<div
						v-for="bar in bars"
						:key="bar.index"
						role="listitem"
						class="flex-1 flex flex-col justify-end h-full"
						:aria-label="
							t('components.knowledge.graphStatsPanel.bucketHint', {
								range: bar.rangeLabel,
								count: bar.count,
							})
						"
						:title="
							t('components.knowledge.graphStatsPanel.bucketHint', {
								range: bar.rangeLabel,
								count: bar.count,
							})
						"
					>
						<div
							class="w-full rounded-t bg-brand/70 min-h-[2px]"
							:style="{ height: `${Math.round(bar.heightFraction * 100)}%` }"
						/>
					</div>
				</div>
				<div class="flex justify-between text-2xs text-text-tertiary mt-1.5" aria-hidden="true">
					<span>{{ pct(0) }}</span>
					<span>{{ pct(1) }}</span>
				</div>
				<div class="flex items-center justify-between text-xs text-text-secondary mt-3">
					<span>
						{{
							t('components.knowledge.graphStatsPanel.mean', { value: pct(stats.confidenceMean) })
						}}
					</span>
					<span>
						{{
							t('components.knowledge.graphStatsPanel.median', {
								value: pct(stats.confidenceMedian),
							})
						}}
					</span>
					<span :class="stats.belowReviewThreshold > 0 ? 'text-warning' : 'text-text-tertiary'">
						{{
							t('components.knowledge.graphStatsPanel.lowConfidence', {
								count: stats.belowReviewThreshold,
							})
						}}
					</span>
				</div>

				<!-- Communities -->
				<h3 class="text-sm font-semibold text-text-primary mt-5 mb-1 flex items-center gap-2">
					<PackagesIcon class="w-4 h-4 text-text-tertiary" aria-hidden="true" />
					{{ t('components.knowledge.graphStatsPanel.communities') }}
					<span class="text-text-tertiary font-normal">
						{{
							t('components.knowledge.graphStatsPanel.communityCount', {
								count: stats.communityCount,
							})
						}}
					</span>
				</h3>
				<p class="text-xs text-text-tertiary mb-3">
					{{ t('components.knowledge.graphStatsPanel.communitiesHint') }}
				</p>
				<ul class="flex flex-wrap gap-1.5">
					<li
						v-for="(size, i) in stats.communitySizes.slice(0, 12)"
						:key="i"
						class="text-2xs px-2 py-0.5 rounded-full bg-bg-surface text-text-secondary border border-border-subtle"
						:style="{ opacity: 0.5 + 0.5 * (size / maxCommunity) }"
						:title="t('components.knowledge.graphStatsPanel.communitySize', { count: size }, size)"
					>
						<span aria-hidden="true">{{ size }}</span>
						<span class="sr-only">{{
							t('components.knowledge.graphStatsPanel.communitySize', { count: size }, size)
						}}</span>
					</li>
				</ul>
			</UiDisclosure>
		</div>

		<!-- Surprising connections (redacted) -->
		<div class="rounded-(--radius-card) bg-surface-2 shadow-surface-1 p-5">
			<h3 class="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
				<SparklesIcon class="w-4 h-4 text-brand" />
				{{ t('components.knowledge.graphStatsPanel.surprising') }}
			</h3>
			<div v-if="stats.surprisingConnections.length === 0" class="text-sm text-text-tertiary">
				{{ t('components.knowledge.graphStatsPanel.surprisingEmpty') }}
			</div>
			<ul v-else class="space-y-2">
				<li
					v-for="(c, i) in stats.surprisingConnections.slice(0, 6)"
					:key="i"
					class="text-sm text-text-secondary flex items-center gap-1.5 min-w-0"
				>
					<!-- native-title: the full title of an entry the link truncates -->
					<NuxtLink
						:to="`/dashboard/knowledge/${c.fromEntryId}`"
						class="truncate text-text-primary hover:text-brand transition-colors max-w-[40%]"
						:title="c.fromTitle"
					>
						{{ c.fromTitle }}
					</NuxtLink>
					<span class="text-2xs uppercase tracking-wide text-text-tertiary flex-shrink-0">
						{{ relationTypeLabel(c.relationType) }}
					</span>
					<!-- native-title: the full title of an entry the link truncates -->
					<NuxtLink
						:to="`/dashboard/knowledge/${c.toEntryId}`"
						class="truncate text-text-primary hover:text-brand transition-colors max-w-[40%]"
						:title="c.toTitle"
					>
						{{ c.toTitle }}
					</NuxtLink>
				</li>
			</ul>
			<p
				v-if="stats.crossContactLinkCount > 0"
				class="text-2xs text-text-tertiary mt-3 flex items-center gap-1.5"
			>
				<ShieldIcon class="w-3.5 h-3.5 flex-shrink-0" />
				{{
					t(
						'components.knowledge.graphStatsPanel.hiddenCrossContact',
						{ count: stats.crossContactLinkCount },
						stats.crossContactLinkCount
					)
				}}
			</p>
		</div>
	</div>
</template>
