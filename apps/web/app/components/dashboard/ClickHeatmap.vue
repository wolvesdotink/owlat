<script setup lang="ts">
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

// Get heat color based on click count (higher = more red/warm)
const getHeatColor = (clicks: number): string => {
	if (clicks === 0) return 'rgba(156, 163, 175, 0.3)'; // gray for 0 clicks
	const intensity = clicks / maxClicks.value;
	// Gradient from yellow (low) through orange to red (high)
	if (intensity < 0.33) {
		return `rgba(250, 204, 21, ${0.4 + intensity * 0.6})`; // yellow
	} else if (intensity < 0.66) {
		return `rgba(249, 115, 22, ${0.5 + intensity * 0.5})`; // orange
	} else {
		return `rgba(239, 68, 68, ${0.6 + intensity * 0.4})`; // red
	}
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

	links.forEach((link, index) => {
		const href = link.getAttribute('href') || '';
		// Skip tracking links, mailto, tel, and anchor links
		if (
			href.startsWith('#') ||
			href.startsWith('mailto:') ||
			href.startsWith('tel:') ||
			href.includes('/t/c/') ||
			href.includes('/unsubscribe')
		) {
			return;
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
	});

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
				<Icon name="lucide:mouse-pointer-click" class="w-4 h-4" />
				<span>Click Heatmap</span>
			</div>
			<div class="flex items-center gap-2">
				<span class="text-xs">Low</span>
				<div class="flex h-3 rounded overflow-hidden">
					<div class="w-6 bg-yellow-400/50" />
					<div class="w-6 bg-orange-500/60" />
					<div class="w-6 bg-red-500/70" />
				</div>
				<span class="text-xs">High</span>
			</div>
		</div>

		<!-- Email Preview with Heatmap -->
		<div class="border border-border-subtle rounded-xl overflow-hidden bg-white">
			<!-- Email content container (sandboxed: no scripts, no app origin) -->
			<iframe
				:srcdoc="previewSrcdoc"
				sandbox=""
				class="w-full h-[600px] border-0 bg-white"
				title="Campaign content with click heatmap"
			/>
		</div>

		<!-- Click Stats Table -->
		<div v-if="processedContent.links.length > 0" class="card overflow-hidden">
			<div class="px-6 py-4 border-b border-border-subtle">
				<div class="flex items-center gap-3">
					<UiIconBox icon="lucide:mouse-pointer-click" size="sm" variant="warning" rounded="lg" />
					<div>
						<h3 class="text-lg font-medium text-text-primary">Link Click Details</h3>
						<p class="text-sm text-text-secondary">Click counts per link in your email</p>
					</div>
				</div>
			</div>

			<div class="divide-y divide-border-subtle">
				<div
					v-for="(link, index) in processedContent.links"
					:key="index"
					class="px-6 py-4 hover:bg-bg-surface transition-colors"
				>
					<div class="flex items-start justify-between gap-4">
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-2 mb-1">
								<Icon name="lucide:external-link" class="w-4 h-4 text-text-tertiary shrink-0" />
								<span class="text-sm font-medium text-text-primary truncate">
									{{ link.text.length > 50 ? link.text.substring(0, 50) + '...' : link.text }}
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

						<div class="flex items-center gap-6 shrink-0">
							<!-- Click Count -->
							<div class="text-right">
								<div class="text-lg font-semibold text-text-primary">
									{{ link.stats?.clicks || 0 }}
								</div>
								<div class="text-xs text-text-tertiary">clicks</div>
							</div>

							<!-- Unique Clickers -->
							<div class="text-right">
								<div class="text-lg font-semibold text-warning">
									{{ link.stats?.uniqueClickers || 0 }}
								</div>
								<div class="text-xs text-text-tertiary">unique</div>
							</div>

							<!-- Click Rate -->
							<div class="text-right min-w-[60px]">
								<div class="text-lg font-semibold text-brand">
									{{ getClickRate(link.stats?.uniqueClickers || 0).toFixed(1) }}%
								</div>
								<div class="text-xs text-text-tertiary">rate</div>
							</div>

							<!-- Heat Indicator -->
							<div
								class="w-4 h-4 rounded-full"
								:style="{ backgroundColor: getHeatColor(link.stats?.clicks || 0) }"
							/>
						</div>
					</div>
				</div>

				<!-- Empty state for no links -->
				<div v-if="processedContent.links.length === 0" class="px-6 py-12 text-center">
					<Icon name="lucide:info" class="w-10 h-10 text-text-tertiary mx-auto mb-3" />
					<p class="text-text-secondary">No trackable links found in this email</p>
				</div>
			</div>
		</div>

		<!-- No Clicks State -->
		<div v-else-if="linkStats.length === 0" class="card p-8 text-center">
			<Icon name="lucide:mouse-pointer-click" class="w-12 h-12 text-text-tertiary mx-auto mb-3" />
			<p class="text-text-secondary font-medium">No link clicks recorded</p>
			<p class="text-sm text-text-tertiary mt-1">
				Link clicks will appear here as recipients interact with your email
			</p>
		</div>
	</div>
</template>

<style scoped>
/* Style the email preview container for better readability */
.email-preview {
	font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
	line-height: 1.5;
	color: #333;
}

.email-preview :deep(a) {
	text-decoration: none;
	transition: all var(--motion-moderate) var(--ease-spring);
}

.email-preview :deep(a:hover) {
	filter: brightness(1.1);
}

.email-preview :deep(img) {
	max-width: 100%;
	height: auto;
}

.email-preview :deep(table) {
	max-width: 100%;
}
</style>
