<script setup lang="ts">
const props = withDefaults(defineProps<{ class?: string }>(), { class: '' })
</script>

<template>
	<div :class="['auth-illustration-wrap', props.class]" aria-hidden="true">
		<svg
			viewBox="0 0 800 400"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			class="auth-illustration"
			preserveAspectRatio="xMidYMid meet"
		>
			<defs>
				<linearGradient id="auth-brand-grad" x1="0%" y1="0%" x2="100%" y2="100%">
					<stop offset="0%" stop-color="var(--color-brand)" />
					<stop offset="100%" stop-color="var(--color-accent)" />
				</linearGradient>
				<linearGradient id="auth-brand-fade" x1="0%" y1="0%" x2="100%" y2="0%">
					<stop offset="0%" stop-color="var(--color-brand)" stop-opacity="0.5" />
					<stop offset="100%" stop-color="var(--color-accent)" stop-opacity="0.15" />
				</linearGradient>
				<linearGradient id="auth-brand-fade-r" x1="100%" y1="0%" x2="0%" y2="0%">
					<stop offset="0%" stop-color="var(--color-accent)" stop-opacity="0.5" />
					<stop offset="100%" stop-color="var(--color-brand)" stop-opacity="0.15" />
				</linearGradient>
				<linearGradient id="auth-surface-grad" x1="0%" y1="0%" x2="0%" y2="100%">
					<stop offset="0%" stop-color="var(--color-bg-surface)" />
					<stop offset="100%" stop-color="var(--color-bg-elevated)" />
				</linearGradient>

				<filter id="auth-glow" x="-50%" y="-50%" width="200%" height="200%">
					<feGaussianBlur in="SourceGraphic" stdDeviation="8" />
				</filter>
				<filter id="auth-shadow" x="-20%" y="-20%" width="140%" height="140%">
					<feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="#000" flood-opacity="0.25" />
				</filter>

				<pattern id="auth-dots" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
					<circle cx="1" cy="1" r="0.4" fill="var(--color-text-tertiary)" opacity="0.12" />
				</pattern>

				<!-- Arrow markers (auto-align to path tangent) -->
				<marker id="auth-arrow-brand" viewBox="0 0 8 6" refX="8" refY="3" markerWidth="8" markerHeight="6" orient="auto-start-reverse">
					<path d="M 0 0 L 8 3 L 0 6 Z" fill="var(--color-brand)" opacity="0.5" />
				</marker>
				<marker id="auth-arrow-accent" viewBox="0 0 8 6" refX="8" refY="3" markerWidth="8" markerHeight="6" orient="auto-start-reverse">
					<path d="M 0 0 L 8 3 L 0 6 Z" fill="var(--color-accent)" opacity="0.4" />
				</marker>
			</defs>

			<!-- Background -->
			<rect width="800" height="400" rx="12" fill="var(--color-bg-elevated)" />
			<rect width="800" height="400" rx="12" fill="url(#auth-dots)" />

			<!-- Content group shifted up for vertical centering -->
			<g transform="translate(0, -36)">

			<!-- ═══ Flow paths ═══ -->
			<!-- Frontend → BetterAuth -->
			<path
				d="M 210 185 C 255 185, 285 195, 325 195"
				stroke="url(#auth-brand-fade)"
				stroke-width="1.2"
				stroke-dasharray="4 4"
				marker-end="url(#auth-arrow-brand)"
				class="auth-flow-path"
			/>
			<!-- BetterAuth → Database -->
			<path
				d="M 475 195 C 515 195, 540 180, 575 180"
				stroke="url(#auth-brand-fade-r)"
				stroke-width="1.2"
				stroke-dasharray="4 4"
				marker-end="url(#auth-arrow-accent)"
				class="auth-flow-path"
			/>
			<!-- BetterAuth → API Keys -->
			<path
				d="M 400 240 L 400 312"
				stroke="var(--color-accent)"
				stroke-width="1"
				stroke-dasharray="3 5"
				stroke-opacity="0.35"
				marker-end="url(#auth-arrow-accent)"
				class="auth-flow-path"
			/>

			<!-- ═══ Section labels ═══ -->
			<text x="132" y="110" fill="var(--color-text-tertiary)" font-size="8" font-family="var(--font-sans, sans-serif)" text-anchor="middle" letter-spacing="0.08em" opacity="0.5">FRONTEND</text>
			<text x="400" y="130" fill="var(--color-text-tertiary)" font-size="8" font-family="var(--font-sans, sans-serif)" text-anchor="middle" letter-spacing="0.08em" opacity="0.5">AUTH LAYER</text>
			<text x="660" y="110" fill="var(--color-text-tertiary)" font-size="8" font-family="var(--font-sans, sans-serif)" text-anchor="middle" letter-spacing="0.08em" opacity="0.5">PERSISTENCE</text>

			<!-- ═══ Frontend Node ═══ -->
			<g class="auth-node auth-node-frontend" filter="url(#auth-shadow)">
				<rect x="55" y="124" width="155" height="104" rx="10" fill="url(#auth-surface-grad)" stroke="var(--color-border-default)" stroke-width="1" />
				<!-- Top accent bar -->
				<rect x="55" y="124" width="155" height="2.5" rx="1.25" fill="url(#auth-brand-grad)" opacity="0.6" />
				<!-- Browser chrome icon -->
				<rect x="72" y="143" width="18" height="12" rx="2" stroke="var(--color-brand)" stroke-width="1" fill="none" />
				<line x1="72" y1="148" x2="90" y2="148" stroke="var(--color-brand)" stroke-width="0.6" opacity="0.4" />
				<circle cx="76" cy="145.5" r="1" fill="var(--color-error)" />
				<circle cx="79.5" cy="145.5" r="1" fill="var(--color-warning)" />
				<circle cx="83" cy="145.5" r="1" fill="var(--color-success)" />
				<!-- Label -->
				<text x="96" y="153" fill="var(--color-text-primary)" font-size="11" font-weight="550" font-family="var(--font-sans, sans-serif)">Frontend</text>
				<!-- useAuth badge -->
				<rect x="72" y="166" width="120" height="18" rx="4" fill="var(--color-brand)" fill-opacity="0.1" stroke="var(--color-brand)" stroke-width="0.5" stroke-opacity="0.25" />
				<text x="82" y="178" fill="var(--color-brand)" font-size="9" font-family="var(--font-mono, monospace)">useAuth()</text>
				<!-- Session indicator -->
				<rect x="72" y="192" width="80" height="16" rx="4" fill="var(--color-bg-soft)" />
				<circle cx="82" cy="200" r="2.5" fill="var(--color-success)" class="auth-pulse" />
				<text x="90" y="203" fill="var(--color-text-secondary)" font-size="8" font-family="var(--font-mono, monospace)">session</text>
			</g>

			<!-- ═══ BetterAuth Node (Central) ═══ -->
			<g class="auth-node auth-node-center" filter="url(#auth-shadow)">
				<!-- Glow behind -->
				<ellipse cx="400" cy="195" rx="70" ry="48" fill="var(--color-brand)" opacity="0.03" filter="url(#auth-glow)" />
				<rect x="325" y="148" width="150" height="92" rx="12" fill="url(#auth-surface-grad)" stroke="var(--color-brand)" stroke-width="1" stroke-opacity="0.35" />
				<!-- Shield icon (centered above text) -->
				<g transform="translate(392, 155)">
					<path d="M 8 1 L 15 4.5 L 15 9 C 15 13 11.5 16 8 17 C 4.5 16 1 13 1 9 L 1 4.5 Z" fill="none" stroke="url(#auth-brand-grad)" stroke-width="1.2" />
					<path d="M 5.5 9 L 7 10.5 L 10.5 7" fill="none" stroke="var(--color-success)" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
				</g>
				<!-- Label -->
				<text x="400" y="186" fill="var(--color-text-primary)" font-size="11" font-weight="550" font-family="var(--font-sans, sans-serif)" text-anchor="middle">BetterAuth</text>
				<!-- Subtitle -->
				<text x="400" y="199" fill="var(--color-text-tertiary)" font-size="8" font-family="var(--font-mono, monospace)" text-anchor="middle">Convex Adapter</text>
				<!-- Org plugin badge -->
				<rect x="352" y="208" width="96" height="18" rx="9" fill="var(--color-accent)" fill-opacity="0.08" stroke="var(--color-accent)" stroke-width="0.5" stroke-opacity="0.25" />
				<text x="400" y="220" fill="var(--color-accent)" font-size="8" font-family="var(--font-mono, monospace)" text-anchor="middle">+ organization</text>
			</g>

			<!-- ═══ Database Node ═══ -->
			<g class="auth-node auth-node-db" filter="url(#auth-shadow)">
				<rect x="575" y="124" width="170" height="158" rx="10" fill="url(#auth-surface-grad)" stroke="var(--color-border-default)" stroke-width="1" />
				<rect x="575" y="124" width="170" height="2.5" rx="1.25" fill="url(#auth-brand-grad)" opacity="0.45" />
				<!-- DB icon -->
				<ellipse cx="594" cy="144" rx="7" ry="3.5" stroke="var(--color-accent)" stroke-width="0.9" fill="none" />
				<path d="M 587 144 L 587 153 C 587 155 590 157 594 157 C 598 157 601 155 601 153 L 601 144" stroke="var(--color-accent)" stroke-width="0.9" fill="none" />
				<!-- Label -->
				<text x="610" y="153" fill="var(--color-text-primary)" font-size="11" font-weight="550" font-family="var(--font-sans, sans-serif)">Tables</text>
				<!-- Table rows -->
				<g transform="translate(590, 166)">
					<rect width="140" height="20" rx="4" fill="var(--color-bg-soft)" />
					<circle cx="10" cy="10" r="2.5" fill="var(--color-brand)" opacity="0.6" />
					<text x="20" y="13" fill="var(--color-text-secondary)" font-size="8" font-family="var(--font-mono, monospace)">user</text>
					<text x="110" y="13" fill="var(--color-text-tertiary)" font-size="7" font-family="var(--font-mono, monospace)">auto</text>
				</g>
				<g transform="translate(590, 190)">
					<rect width="140" height="20" rx="4" fill="var(--color-bg-soft)" />
					<circle cx="10" cy="10" r="2.5" fill="var(--color-success)" opacity="0.6" />
					<text x="20" y="13" fill="var(--color-text-secondary)" font-size="8" font-family="var(--font-mono, monospace)">session</text>
					<text x="110" y="13" fill="var(--color-text-tertiary)" font-size="7" font-family="var(--font-mono, monospace)">auto</text>
				</g>
				<g transform="translate(590, 214)">
					<rect width="140" height="20" rx="4" fill="var(--color-bg-soft)" />
					<circle cx="10" cy="10" r="2.5" fill="var(--color-accent)" opacity="0.6" />
					<text x="20" y="13" fill="var(--color-text-secondary)" font-size="8" font-family="var(--font-mono, monospace)">organization</text>
					<text x="110" y="13" fill="var(--color-text-tertiary)" font-size="7" font-family="var(--font-mono, monospace)">auto</text>
				</g>
				<g transform="translate(590, 238)">
					<rect width="140" height="20" rx="4" fill="var(--color-bg-soft)" />
					<circle cx="10" cy="10" r="2.5" fill="var(--color-info)" opacity="0.6" />
					<text x="20" y="13" fill="var(--color-text-secondary)" font-size="8" font-family="var(--font-mono, monospace)">member</text>
					<text x="110" y="13" fill="var(--color-text-tertiary)" font-size="7" font-family="var(--font-mono, monospace)">auto</text>
				</g>
			</g>

			<!-- ═══ Role badges (under database) ═══ -->
			<g transform="translate(590, 296)">
				<rect width="44" height="18" rx="9" fill="var(--color-brand)" fill-opacity="0.12" stroke="var(--color-brand)" stroke-width="0.6" stroke-opacity="0.35" />
				<text x="22" y="9" fill="var(--color-brand)" font-size="7.5" font-weight="550" font-family="var(--font-mono, monospace)" text-anchor="middle" dominant-baseline="central">owner</text>
			</g>
			<g transform="translate(642, 296)">
				<rect width="44" height="18" rx="9" fill="var(--color-accent)" fill-opacity="0.1" stroke="var(--color-accent)" stroke-width="0.6" stroke-opacity="0.3" />
				<text x="22" y="9" fill="var(--color-accent)" font-size="7.5" font-weight="550" font-family="var(--font-mono, monospace)" text-anchor="middle" dominant-baseline="central">admin</text>
			</g>
			<g transform="translate(694, 296)">
				<rect width="44" height="18" rx="9" fill="var(--color-info)" fill-opacity="0.1" stroke="var(--color-info)" stroke-width="0.6" stroke-opacity="0.3" />
				<text x="22" y="9" fill="var(--color-info)" font-size="7.5" font-weight="550" font-family="var(--font-mono, monospace)" text-anchor="middle" dominant-baseline="central">editor</text>
			</g>

			<!-- ═══ API Keys Node ═══ -->
			<g class="auth-node auth-node-api" filter="url(#auth-shadow)">
				<rect x="318" y="320" width="164" height="60" rx="10" fill="url(#auth-surface-grad)" stroke="var(--color-border-default)" stroke-width="1" />
				<!-- Key icon -->
				<g transform="translate(334, 336)">
					<circle cx="5" cy="5" r="4" stroke="var(--color-accent)" stroke-width="1" fill="none" />
					<line x1="9" y1="5" x2="18" y2="5" stroke="var(--color-accent)" stroke-width="1" />
					<line x1="15" y1="5" x2="15" y2="8" stroke="var(--color-accent)" stroke-width="1" />
					<line x1="18" y1="5" x2="18" y2="8" stroke="var(--color-accent)" stroke-width="1" />
				</g>
				<text x="360" y="347" fill="var(--color-text-primary)" font-size="10" font-weight="550" font-family="var(--font-sans, sans-serif)">API Keys</text>
				<!-- Key format -->
				<rect x="334" y="355" width="132" height="12" rx="2" fill="var(--color-bg-soft)" />
				<text x="342" y="364" fill="var(--color-text-tertiary)" font-size="7" font-family="var(--font-mono, monospace)">lm_live_...</text>
				<!-- REST badge inline -->
				<rect x="430" y="355" width="30" height="12" rx="2" fill="var(--color-success)" fill-opacity="0.15" />
				<text x="445" y="364" fill="var(--color-success)" font-size="6.5" font-weight="700" font-family="var(--font-mono, monospace)" text-anchor="middle">REST</text>
			</g>

			<!-- ═══ Owl silhouette watermark (very subtle) ═══ -->
			<g transform="translate(52, 310) scale(0.055)" opacity="0.04">
				<path d="M626.922 872.737c72.812 0 128.59-100.82 154.99-153.92 27.5-55.3 35.6-112.8 23.5-166.8-6.5-29-19.7-56.7-37.8-79.1l-6.7-8.3 5-7.7c10.5-16 19-36.5 23.3-56.5 3.2-14.8 3.2-45.6 0-60.2-3-13.9-6.4-23.9-12.7-37-5.1-10.9-14.9-26.8-18-29.4-2.2-1.8-1.9-3.5 1.3-5.6 4.3-2.8 16-14.4 20.6-20.4 9.4-12.2 15.9-25.9 20.3-42.9 4.5-17.4 4.3-49.1-.4-54.3-2.7-3-5.6-2.1-14.4 4.8-24.5 19.4-49.7 33.9-79.7 46-10.768 4.37-21.834 8.065-33 11.274-4.533 1.303-9.83 2.715-14.475 3.716-2.415.52-6.817 1.408-9.525 1.41-.707 0-1.4-.205-2.088-.368-3.965-.94-10.904-3.28-13.612-4.233-26.2-9.2-50.4-15.1-78.5-19-15.9-2.3-65.9-2.6-82-.6-28.2 3.6-51.6 9-79.1 18.3-4.425 1.46-8.886 2.812-13.35 4.15-.564.17-5.837 1.696-7.35 1.75-1.433.051-5.828-.866-6.738-1.078-3.707-.866-7.41-1.756-11.087-2.747-7.548-2.034-17.17-4.91-24.575-7.575-33.7-12.2-64.6-29-90.3-49.1-10.6-8.3-13-9.3-16.2-7-3.182 2.273-3.746 6.997-4.136 10.542a57 57 0 0 0-.322 3.985c-.415 10.65-.486 21.435 1.158 31.998 1.04 6.674 2.826 13.188 5 19.575 6.9 20.2 21.9 41 37.3 51.4 3.7 2.5 4.6 4.3 2.7 5.5-2 1.2-12.8 18.2-17.3 27.1-5.7 11.4-11.1 26.7-13.9 39.8-3.1 14.5-3.1 43.5 0 58.3 4.5 20.9 12.8 41.1 23.5 57.6l5.4 8.3-4.4 4.9c-6.9 7.7-19.7 27.6-25.8 39.9-16 32.7-23 72.8-19.5 112.6 4.8 54.3 27 107.4 64.6 154.5 11.2 14 38.8 41.6 52.4 52.5 12.3 9.7 30.7 22.1 42.3 28.4" fill="var(--color-brand)" />
			</g>


			</g><!-- end content group -->

			<!-- Top border accent -->
			<rect x="0" y="0" width="800" height="1.5" rx="0.75" fill="url(#auth-brand-grad)" opacity="0.12" />
		</svg>
	</div>
</template>

<style scoped>
.auth-illustration-wrap {
	width: 100%;
	max-width: 800px;
	margin: 2rem auto;
}

.auth-illustration {
	width: 100%;
	height: auto;
	border-radius: 12px;
	border: 1px solid var(--color-border-default);
	overflow: hidden;
}

/* ── Session pulse ── */
.auth-pulse {
	animation: auth-pulse-anim 3s ease-in-out infinite;
	transform-origin: center;
}
@keyframes auth-pulse-anim {
	0%, 100% { opacity: 0.8; }
	50% { opacity: 0.4; }
}

/* ── Flow paths ── */
.auth-flow-path {
	animation: auth-dash 4s linear infinite;
}
@keyframes auth-dash {
	to { stroke-dashoffset: -24; }
}

/* ── Node entrance ── */
.auth-node {
	opacity: 0;
	animation: auth-node-in var(--motion-choreo) var(--ease-spring) forwards;
}
.auth-node-frontend { animation-delay: 0.1s; }
.auth-node-center { animation-delay: 0.2s; }
.auth-node-db { animation-delay: 0.35s; }
.auth-node-api { animation-delay: 0.5s; }

@keyframes auth-node-in {
	from { opacity: 0; transform: translateY(8px); }
	to { opacity: 1; transform: translateY(0); }
}

/* ── Reduced motion ── */
@media (prefers-reduced-motion: reduce) {
	.auth-pulse,
	.auth-flow-path,
	.auth-node {
		animation: none;
		opacity: 1;
	}
}
</style>
