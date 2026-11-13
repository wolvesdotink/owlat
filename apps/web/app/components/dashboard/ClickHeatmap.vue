<script setup lang="ts">
import { CircleInfoIcon, CursorClickIcon, ExternalLinkIcon } from '@coolicons/vue';

interface LinkStat {
	url: string;
	clicks: number;
	uniqueClickers: number;
}

interface Props {
	htmlContent: string;
	linkStats: readonly LinkStat[];
	totalDelivered: number;
}

const props = defineProps<Props>();

const { t } = useI18n();

// Create a lookup map for quick access to link stats by URL
const linkStatsMap = computed(() => {
	const map: Record<string, LinkStat> = {};
	for (const stat of props.linkStats) {
		map[stat.url] = stat;
	}
	return map;
});

// Calculate max clicks for color gradient scaling
const maxClicks = computed(() => {
	if (props.linkStats.length === 0) return 1;
	return Math.max(...props.linkStats.map((s) => s.clicks), 1);
});

// The one heat scale, painted on the links in the preview, on each row's dot
// and in the legend, so the legend explains what the map shows. Literal colours
// rather than theme tokens: the preview paper is white in both themes.
type HeatTier = 'none' | 'low' | 'medium' | 'high';
const HEAT_RGB: Record<Exclude<HeatTier, 'none'>, string> = {
	low: '250, 204, 21',
	medium: '249, 115, 22',
	high: '239, 68, 68',
};
const LEGEND_TIERS = ['low', 'medium', 'high'] as const;
const legendColor = (tier: Exclude<HeatTier, 'none'>) => `rgba(${HEAT_RGB[tier]}, 0.8)`;

function heatTier(clicks: number): HeatTier {
	if (clicks === 0) return 'none';
	const intensity = clicks / maxClicks.value;
	if (intensity < 0.33) return 'low';
	if (intensity < 0.66) return 'medium';
	return 'high';
}

// Get heat color based on click count (higher = more red/warm)
const getHeatColor = (clicks: number): string => {
	const tier = heatTier(clicks);
	if (tier === 'none') return 'rgba(156, 163, 175, 0.3)';
	const intensity = clicks / maxClicks.value;
	const alpha =
		tier === 'low'
			? 0.4 + intensity * 0.6
			: tier === 'medium'
				? 0.5 + intensity * 0.5
				: 0.6 + intensity * 0.4;
	return `rgba(${HEAT_RGB[tier]}, ${alpha})`;
};

const TIER_LABEL: Record<HeatTier, string> = {
	none: 'components.dashboard.clickHeatmap.tierNone',
	low: 'components.dashboard.clickHeatmap.low',
	medium: 'components.dashboard.clickHeatmap.medium',
	high: 'components.dashboard.clickHeatmap.high',
};

// Calculate click rate for a URL
const getClickRate = (uniqueClickers: number): number => {
	if (props.totalDelivered === 0) return 0;
	return (uniqueClickers / props.totalDelivered) * 100;
};

// Process HTML to extract links and create enhanced content
const processedContent = computed(() => {
	if (!props.htmlContent)
		return { html: '', links: [] as Array<{ url: string; text: string; stats: LinkStat | null }> };

	const parser = new DOMParser();
	const doc = parser.parseFromString(props.htmlContent, 'text/html');
	const links = doc.querySelectorAll('a[href]');
	const extractedLinks: Array<{ url: string; text: string; stats: LinkStat | null }> = [];

	for (const [index, link] of links.entries()) {
		const href = link.getAttribute('href') || '';
		// Skip tracking links, mailto, tel, and anchor links
		if (
			href.startsWith('#') ||
			href.startsWith('mailto:') ||
			href.startsWith('tel:') ||
			href.includes('/t/c/') ||
			href.includes('/unsubscribe')
		) {
			continue;
		}

		const text = link.textContent?.trim() || href;
		const stats = linkStatsMap.value[href] || null;

		extractedLinks.push({ url: href, text, stats });

		// Add a data attribute and visual styling to the link
		link.setAttribute('data-heatmap-link', index.toString());
		const clicks = stats?.clicks || 0;
		const heatColor = getHeatColor(clicks);

		// Add inline styles for the heat effect
		const existingStyle = link.getAttribute('style') || '';
		link.setAttribute(
			'style',
			`${existingStyle}; background: ${heatColor}; box-shadow: 0 0 0 4px ${heatColor}; border-radius: 4px; position: relative;`
		);
	}

	return {
		html: doc.body.innerHTML,
		links: extractedLinks,
	};
});

// Sandboxed-iframe document: campaign HTML is org-authored but still
// untrusted enough (imported templates, variables) that it must not run in
// the app origin. sandbox="" disables scripts and same-origin; the meta-CSP
// is defense-in-depth (images + inline styles only).
const previewSrcdoc = computed(() => {
	return [
		'<!doctype html><html><head>',
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src https: data: cid:; style-src \'unsafe-inline\'">',
		'<style>body{margin:16px;font-family:sans-serif;background:#fff}</style>',
		'</head><body>',
		processedContent.value.html,
		'</body></html>',
	].join('');
});
</script>

<template>
	<div class="space-y-6">
		<!-- Heatmap Legend -->
		<div class="flex items-center gap-4 text-sm text-text-secondary">
			<div class="flex items-center gap-2">
				<CursorClickIcon class="w-4 h-4" />
				<span>{{ t('components.dashboard.clickHeatmap.legendTitle') }}</span>
			</div>
			<div class="flex items-center gap-2">
				<span class="text-xs">{{ t('components.dashboard.clickHeatmap.low') }}</span>
				<div class="flex h-3 rounded overflow-hidden" aria-hidden="true">
					<div
						v-for="tier in LEGEND_TIERS"
						:key="tier"
						class="w-6"
						:style="{ backgroundColor: legendColor(tier) }"
					/>
				</div>
				<span class="text-xs">{{ t('components.dashboard.clickHeatmap.high') }}</span>
			</div>
		</div>

		<!-- Email Preview with Heatmap.
		     palette-ok: the paper stays literally white in both app themes — campaign
		     HTML carries its own (light) colors and the srcdoc body is painted #fff,
		     so a theme token here would only show as a mismatched flash behind the
		     frame. -->
		<!-- Campaign HTML is laid out for ~600px, so on a narrow screen the frame
		     keeps its natural width and the reader pans instead of getting a
		     squeezed, unreadable render. -->
		<div class="border border-border-subtle rounded-xl overflow-x-auto bg-white">
			<!-- Email content container (sandboxed: no scripts, no app origin).
			     palette-ok: same white paper as the frame above. -->
			<iframe
				:srcdoc="previewSrcdoc"
				sandbox=""
				class="w-full min-w-[640px] h-[600px] border-0 bg-white"
				:title="t('components.dashboard.clickHeatmap.frameTitle')"
			/>
		</div>

		<!-- Click Stats Table -->
		<div v-if="processedContent.links.length > 0" class="card overflow-hidden">
			<div class="px-4 sm:px-6 py-4 border-b border-border-subtle">
				<div class="flex items-center gap-3">
					<UiIconBox :icon="CursorClickIcon" size="sm" variant="warning" rounded="lg" />
					<div>
						<h3 class="text-lg font-medium text-text-primary">
							{{ t('components.dashboard.clickHeatmap.detailsTitle') }}
						</h3>
						<p class="text-sm text-text-secondary">
							{{ t('components.dashboard.clickHeatmap.detailsSubtitle') }}
						</p>
					</div>
				</div>
			</div>

			<div class="divide-y divide-border-subtle">
				<div
					v-for="(link, index) in processedContent.links"
					:key="index"
					class="px-4 sm:px-6 py-4 hover:bg-bg-surface transition-colors"
				>
					<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2 mb-1">
								<ExternalLinkIcon class="w-4 h-4 text-text-tertiary shrink-0" />
								<span class="text-sm font-medium text-text-primary truncate" :title="link.text">
									{{ link.text }}
								</span>
							</div>
							<a
								:href="link.url"
								target="_blank"
								rel="noopener noreferrer"
								class="text-xs text-text-tertiary hover:text-brand truncate block max-w-md"
							>
								{{ link.url }}
							</a>
						</div>

						<div class="flex items-center gap-4 sm:gap-6 shrink-0">
							<!-- Click Count -->
							<div class="text-right">
								<div class="text-lg font-semibold text-text-primary">
									{{ link.stats?.clicks || 0 }}
								</div>
								<div class="text-xs text-text-tertiary">
									{{ t('components.dashboard.clickHeatmap.clicks') }}
								</div>
							</div>

							<!-- Unique Clickers -->
							<div class="text-right">
								<div class="text-lg font-semibold text-text-primary">
									{{ link.stats?.uniqueClickers || 0 }}
								</div>
								<div class="text-xs text-text-tertiary">
									{{ t('components.dashboard.clickHeatmap.unique') }}
								</div>
							</div>

							<!-- Click Rate -->
							<div class="text-right min-w-[60px]">
								<div class="text-lg font-semibold text-text-primary">
									{{ getClickRate(link.stats?.uniqueClickers || 0).toFixed(1) }}%
								</div>
								<div class="text-xs text-text-tertiary">
									{{ t('components.dashboard.clickHeatmap.rate') }}
								</div>
							</div>

							<!-- Heat Indicator: its tier in words for assistive tech. -->
							<div
								class="w-4 h-4 rounded-full"
								role="img"
								:aria-label="t(TIER_LABEL[heatTier(link.stats?.clicks || 0)])"
								:style="{ backgroundColor: getHeatColor(link.stats?.clicks || 0) }"
							/>
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- No Clicks State -->
		<div v-else-if="linkStats.length === 0" class="card p-8 text-center">
			<CursorClickIcon class="w-12 h-12 text-text-tertiary mx-auto mb-3" :stroke-width="1.5" />
			<p class="text-text-secondary font-medium">
				{{ t('components.dashboard.clickHeatmap.noClicks') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1">
				{{ t('components.dashboard.clickHeatmap.noClicksHint') }}
			</p>
		</div>

		<!-- Clicks were recorded, but none of them is on a link this HTML still
		     carries: say so instead of showing nothing. -->
		<div v-else class="card px-6 py-12 text-center">
			<CircleInfoIcon class="w-10 h-10 text-text-tertiary mx-auto mb-3" :stroke-width="1.5" />
			<p class="text-text-secondary">{{ t('components.dashboard.clickHeatmap.noLinks') }}</p>
		</div>
	</div>
</template>
