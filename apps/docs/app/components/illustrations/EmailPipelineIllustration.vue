<script setup lang="ts">
const props = withDefaults(defineProps<{ class?: string }>(), { class: '' })
</script>

<template>
	<div :class="['email-illustration-wrap', props.class]" aria-hidden="true">
		<svg
			viewBox="0 70 800 360"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			class="email-illustration"
			preserveAspectRatio="xMidYMid meet"
		>
			<defs>
				<!-- Gradients -->
				<linearGradient id="email-brand-grad" x1="0%" y1="0%" x2="100%" y2="100%">
					<stop offset="0%" stop-color="var(--color-brand)" />
					<stop offset="100%" stop-color="var(--color-accent)" />
				</linearGradient>
				<linearGradient id="email-flow-grad" x1="0%" y1="0%" x2="100%" y2="0%">
					<stop offset="0%" stop-color="var(--color-brand)" stop-opacity="0.5" />
					<stop offset="50%" stop-color="var(--color-accent)" stop-opacity="0.3" />
					<stop offset="100%" stop-color="var(--color-brand)" stop-opacity="0.1" />
				</linearGradient>
				<linearGradient id="email-surface-grad" x1="0%" y1="0%" x2="0%" y2="100%">
					<stop offset="0%" stop-color="var(--color-bg-surface)" />
					<stop offset="100%" stop-color="var(--color-bg-elevated)" />
				</linearGradient>

				<!-- Filters -->
				<filter id="email-shadow" x="-20%" y="-20%" width="140%" height="140%">
					<feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#000" flood-opacity="0.3" />
				</filter>
				<filter id="email-glow" x="-50%" y="-50%" width="200%" height="200%">
					<feGaussianBlur in="SourceGraphic" stdDeviation="6" />
				</filter>

				<!-- Dot pattern -->
				<pattern id="email-dots" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
					<circle cx="1" cy="1" r="0.5" fill="var(--color-text-tertiary)" opacity="0.12" />
				</pattern>
			</defs>

			<!-- Background -->
			<rect y="70" width="800" height="360" rx="16" fill="var(--color-bg-elevated)" />
			<rect y="70" width="800" height="360" rx="16" fill="url(#email-dots)" />

			<!-- ═══ Flow paths ═══ -->
			<!-- Builder → JSON -->
			<path
				d="M 195 190 C 225 190, 230 190, 248 190"
				stroke="url(#email-flow-grad)"
				stroke-width="1.5"
				stroke-dasharray="4 4"
				class="email-flow-path"
			/>
			<!-- JSON → Renderer -->
			<path
				d="M 310 190 C 340 190, 345 190, 358 190"
				stroke="url(#email-flow-grad)"
				stroke-width="1.5"
				stroke-dasharray="4 4"
				class="email-flow-path"
			/>
			<!-- Renderer → Outputs (fan out) -->
			<path
				d="M 490 175 C 520 170, 530 155, 555 150"
				stroke="var(--color-brand)"
				stroke-width="1"
				stroke-dasharray="3 5"
				stroke-opacity="0.4"
				class="email-flow-path"
			/>
			<path
				d="M 490 190 C 520 190, 530 190, 555 190"
				stroke="var(--color-brand)"
				stroke-width="1.5"
				stroke-dasharray="4 4"
				stroke-opacity="0.5"
				class="email-flow-path"
			/>
			<path
				d="M 490 205 C 520 210, 530 225, 555 230"
				stroke="var(--color-brand)"
				stroke-width="1"
				stroke-dasharray="3 5"
				stroke-opacity="0.3"
				class="email-flow-path"
			/>
			<!-- Outputs → Providers -->
			<path
				d="M 650 190 C 680 220, 660 280, 640 300"
				stroke="var(--color-accent)"
				stroke-width="1"
				stroke-dasharray="3 6"
				stroke-opacity="0.3"
				class="email-flow-path"
			/>

			<!-- ═══ Email Builder Node ═══ -->
			<g class="email-node email-node-builder" filter="url(#email-shadow)">
				<rect x="32" y="120" width="163" height="150" rx="12" fill="url(#email-surface-grad)" stroke="var(--color-border-default)" stroke-width="1" />
				<rect x="32" y="120" width="163" height="3" rx="1.5" fill="url(#email-brand-grad)" opacity="0.7" />

				<!-- Mini canvas mockup -->
				<rect x="48" y="138" width="130" height="80" rx="6" fill="var(--color-bg-soft)" stroke="var(--color-border-subtle)" stroke-width="0.5" />

				<!-- Block representations inside canvas -->
				<!-- Text block -->
				<rect x="56" y="146" width="80" height="8" rx="2" fill="var(--color-text-tertiary)" opacity="0.3" />
				<rect x="56" y="156" width="60" height="4" rx="1" fill="var(--color-text-tertiary)" opacity="0.15" />
				<!-- Image block -->
				<rect x="56" y="166" width="50" height="28" rx="3" fill="var(--color-brand)" fill-opacity="0.1" stroke="var(--color-brand)" stroke-width="0.5" stroke-opacity="0.3" />
				<path d="M 68 180 L 74 174 L 80 180 L 86 172 L 98 184" stroke="var(--color-brand)" stroke-width="0.7" fill="none" opacity="0.4" />
				<!-- Button block -->
				<rect x="56" y="200" width="44" height="12" rx="6" fill="var(--color-brand)" fill-opacity="0.2" stroke="var(--color-brand)" stroke-width="0.5" stroke-opacity="0.5" />

				<!-- Floating block type badges -->
				<g class="email-block-badge email-bb-1">
					<rect x="116" y="148" width="54" height="14" rx="3" fill="var(--color-bg-surface)" stroke="var(--color-border-default)" stroke-width="0.5" />
					<text x="120" y="158" fill="var(--color-text-secondary)" font-size="7" font-family="var(--font-mono, monospace)">text</text>
				</g>
				<g class="email-block-badge email-bb-2">
					<rect x="116" y="168" width="54" height="14" rx="3" fill="var(--color-bg-surface)" stroke="var(--color-border-default)" stroke-width="0.5" />
					<text x="120" y="178" fill="var(--color-text-secondary)" font-size="7" font-family="var(--font-mono, monospace)">image</text>
				</g>
				<g class="email-block-badge email-bb-3">
					<rect x="116" y="188" width="54" height="14" rx="3" fill="var(--color-bg-surface)" stroke="var(--color-border-default)" stroke-width="0.5" />
					<text x="120" y="198" fill="var(--color-text-secondary)" font-size="7" font-family="var(--font-mono, monospace)">button</text>
				</g>

				<!-- Label -->
				<text x="113" y="237" fill="var(--color-text-primary)" font-size="10" font-weight="600" font-family="var(--font-sans, sans-serif)" text-anchor="middle">Email Builder</text>
				<!-- Subtitle -->
				<text x="113" y="250" fill="var(--color-text-tertiary)" font-size="8" font-family="var(--font-mono, monospace)" text-anchor="middle">18 block types</text>
			</g>

			<!-- ═══ JSON intermediary ═══ -->
			<g class="email-node email-node-json">
				<rect x="248" y="168" width="62" height="44" rx="8" fill="var(--color-bg-surface)" stroke="var(--color-border-default)" stroke-width="1" />
				<!-- JSON brackets -->
				<text x="258" y="186" fill="var(--color-accent)" font-size="11" font-weight="600" font-family="var(--font-mono, monospace)">{</text>
				<rect x="268" y="180" width="22" height="3" rx="1" fill="var(--color-text-tertiary)" opacity="0.3" />
				<rect x="268" y="186" width="16" height="3" rx="1" fill="var(--color-brand)" opacity="0.3" />
				<text x="292" y="200" fill="var(--color-accent)" font-size="11" font-weight="600" font-family="var(--font-mono, monospace)">}</text>
				<text x="279" y="224" fill="var(--color-text-tertiary)" font-size="7" font-family="var(--font-mono, monospace)" text-anchor="middle">JSON</text>
			</g>

			<!-- ═══ Renderer Node (Central) ═══ -->
			<g class="email-node email-node-renderer" filter="url(#email-shadow)">
				<!-- Glow -->
				<ellipse cx="424" cy="190" rx="75" ry="50" fill="var(--color-brand)" opacity="0.04" filter="url(#email-glow)" />
				<rect x="358" y="148" width="132" height="84" rx="14" fill="url(#email-surface-grad)" stroke="var(--color-brand)" stroke-width="1" stroke-opacity="0.4" />

				<!-- Gear/cog icon for rendering -->
				<g transform="translate(378, 162)">
					<circle cx="8" cy="8" r="5" stroke="url(#email-brand-grad)" stroke-width="1.2" fill="none" />
					<circle cx="8" cy="8" r="2" fill="var(--color-brand)" opacity="0.5" />
					<!-- Cog teeth (simplified) -->
					<line x1="8" y1="1" x2="8" y2="3" stroke="var(--color-brand)" stroke-width="1.2" />
					<line x1="8" y1="13" x2="8" y2="15" stroke="var(--color-brand)" stroke-width="1.2" />
					<line x1="1" y1="8" x2="3" y2="8" stroke="var(--color-brand)" stroke-width="1.2" />
					<line x1="13" y1="8" x2="15" y2="8" stroke="var(--color-brand)" stroke-width="1.2" />
				</g>
				<text x="400" y="174" fill="var(--color-text-primary)" font-size="10" font-weight="600" font-family="var(--font-sans, sans-serif)">Renderer</text>

				<!-- Features list -->
				<g transform="translate(370, 186)">
					<rect width="98" height="12" rx="2" fill="var(--color-brand)" fill-opacity="0.08" />
					<text x="4" y="9" fill="var(--color-brand)" font-size="6.5" font-family="var(--font-mono, monospace)">CSS inline</text>
				</g>
				<g transform="translate(370, 200)">
					<rect width="98" height="12" rx="2" fill="var(--color-accent)" fill-opacity="0.08" />
					<text x="4" y="9" fill="var(--color-accent)" font-size="6.5" font-family="var(--font-mono, monospace)">VML / dark mode</text>
				</g>
				<g transform="translate(370, 214)">
					<rect width="98" height="12" rx="2" fill="var(--color-info)" fill-opacity="0.08" />
					<text x="4" y="9" fill="var(--color-info)" font-size="6.5" font-family="var(--font-mono, monospace)">responsive</text>
				</g>
			</g>

			<!-- ═══ Output Formats ═══ -->
			<!-- HTML (primary) -->
			<g class="email-node email-node-html" filter="url(#email-shadow)">
				<rect x="555" y="164" width="95" height="52" rx="10" fill="url(#email-surface-grad)" stroke="var(--color-brand)" stroke-width="1" stroke-opacity="0.5" />
				<!-- HTML tag icon -->
				<text x="570" y="186" fill="var(--color-brand)" font-size="10" font-family="var(--font-mono, monospace)" font-weight="700">&lt;/&gt;</text>
				<text x="600" y="186" fill="var(--color-text-primary)" font-size="10" font-weight="600" font-family="var(--font-sans, sans-serif)">HTML</text>
				<text x="602" y="202" fill="var(--color-text-tertiary)" font-size="7" font-family="var(--font-mono, monospace)" text-anchor="middle">primary</text>
			</g>

			<!-- Plain Text -->
			<g class="email-node email-node-text">
				<rect x="555" y="130" width="95" height="28" rx="6" fill="var(--color-bg-surface)" stroke="var(--color-border-default)" stroke-width="0.7" />
				<rect x="565" y="140" width="24" height="3" rx="1" fill="var(--color-text-tertiary)" opacity="0.3" />
				<rect x="592" y="140" width="16" height="3" rx="1" fill="var(--color-text-tertiary)" opacity="0.2" />
				<text x="565" y="152" fill="var(--color-text-secondary)" font-size="7" font-family="var(--font-mono, monospace)">Plain Text</text>
			</g>

			<!-- AMP -->
			<g class="email-node email-node-amp">
				<rect x="555" y="222" width="95" height="28" rx="6" fill="var(--color-bg-surface)" stroke="var(--color-border-default)" stroke-width="0.7" />
				<!-- Lightning bolt -->
				<path d="M 570 229 L 575 229 L 573 234 L 578 234 L 571 243 L 573 237 L 569 237 Z" fill="var(--color-warning)" opacity="0.6" />
				<text x="583" y="240" fill="var(--color-text-secondary)" font-size="7" font-family="var(--font-mono, monospace)">AMP</text>
			</g>

			<!-- ═══ Provider Layer ═══ -->
			<g class="email-node email-node-providers" filter="url(#email-shadow)">
				<rect x="555" y="282" width="200" height="116" rx="12" fill="url(#email-surface-grad)" stroke="var(--color-border-default)" stroke-width="1" />
				<rect x="555" y="282" width="200" height="3" rx="1.5" fill="url(#email-brand-grad)" opacity="0.5" />

				<!-- Server icon -->
				<g transform="translate(572, 298)">
					<rect width="18" height="13" rx="2" stroke="var(--color-brand)" stroke-width="1" fill="none" />
					<line x1="0" y1="6.5" x2="18" y2="6.5" stroke="var(--color-brand)" stroke-width="0.8" />
					<circle cx="14" cy="3.5" r="1.5" fill="var(--color-brand)" opacity="0.6" />
					<circle cx="14" cy="9.5" r="1.5" fill="var(--color-brand)" opacity="0.6" />
				</g>
				<text x="596" y="308" fill="var(--color-text-primary)" font-size="10" font-weight="600" font-family="var(--font-sans, sans-serif)">Delivery</text>

				<!-- MTA (default) -->
				<g transform="translate(572, 322)">
					<rect width="170" height="22" rx="4" fill="var(--color-brand)" fill-opacity="0.08" stroke="var(--color-brand)" stroke-width="0.5" stroke-opacity="0.3" />
					<circle cx="10" cy="11" r="3" fill="var(--color-brand)" opacity="0.8" />
					<text x="20" y="14" fill="var(--color-text-primary)" font-size="8" font-weight="600" font-family="var(--font-mono, monospace)">Owlat MTA</text>
					<text x="88" y="14" fill="var(--color-brand)" font-size="6" font-family="var(--font-mono, monospace)">default</text>
				</g>

				<!-- Optional: Resend & SES -->
				<text x="572" y="356" fill="var(--color-text-tertiary)" font-size="6" font-family="var(--font-mono, monospace)" letter-spacing="0.03em">OPTIONAL</text>
				<g transform="translate(572, 360)">
					<rect width="82" height="18" rx="4" fill="var(--color-bg-soft)" />
					<circle cx="10" cy="9" r="2.5" fill="var(--color-accent)" opacity="0.5" />
					<text x="18" y="12" fill="var(--color-text-tertiary)" font-size="7" font-family="var(--font-mono, monospace)">Resend</text>
				</g>
				<g transform="translate(662, 360)">
					<rect width="82" height="18" rx="4" fill="var(--color-bg-soft)" />
					<circle cx="10" cy="9" r="2.5" fill="var(--color-accent)" opacity="0.5" />
					<text x="18" y="12" fill="var(--color-text-tertiary)" font-size="7" font-family="var(--font-mono, monospace)">AWS SES</text>
				</g>

				<!-- Rate limit badge -->
				<g transform="translate(572, 384)">
					<rect width="170" height="8" rx="2" fill="var(--color-brand)" fill-opacity="0.06" />
				</g>
			</g>

			<!-- ═══ Domain Verification (bottom-left) ═══ -->
			<g class="email-node email-node-dns" filter="url(#email-shadow)">
				<rect x="32" y="300" width="200" height="94" rx="12" fill="url(#email-surface-grad)" stroke="var(--color-border-default)" stroke-width="1" />

				<!-- Shield + check icon -->
				<g transform="translate(48, 314)">
					<path d="M 8 0 L 16 4 L 16 10 C 16 14 12 17 8 18 C 4 17 0 14 0 10 L 0 4 Z" fill="none" stroke="var(--color-success)" stroke-width="1" />
					<path d="M 5 9 L 7 11 L 11 7" fill="none" stroke="var(--color-success)" stroke-width="1" stroke-linecap="round" />
				</g>
				<text x="72" y="326" fill="var(--color-text-primary)" font-size="10" font-weight="600" font-family="var(--font-sans, sans-serif)">Domain Verification</text>

				<!-- DNS records -->
				<g transform="translate(48, 340)">
					<rect width="42" height="14" rx="3" fill="var(--color-success)" fill-opacity="0.1" />
					<text x="6" y="10" fill="var(--color-success)" font-size="7" font-weight="600" font-family="var(--font-mono, monospace)">SPF</text>
				</g>
				<g transform="translate(96, 340)">
					<rect width="46" height="14" rx="3" fill="var(--color-info)" fill-opacity="0.1" />
					<text x="6" y="10" fill="var(--color-info)" font-size="7" font-weight="600" font-family="var(--font-mono, monospace)">DKIM</text>
				</g>
				<g transform="translate(148, 340)">
					<rect width="64" height="14" rx="3" fill="var(--color-accent)" fill-opacity="0.1" />
					<text x="6" y="10" fill="var(--color-accent)" font-size="7" font-weight="600" font-family="var(--font-mono, monospace)">DMARC</text>
				</g>

				<!-- Status flow -->
				<g transform="translate(48, 364)">
					<circle cx="4" cy="6" r="3" fill="var(--color-warning)" opacity="0.4" />
					<text x="12" y="9" fill="var(--color-text-tertiary)" font-size="6.5" font-family="var(--font-mono, monospace)">pending</text>
					<path d="M 55 6 L 65 6" stroke="var(--color-text-tertiary)" stroke-width="0.5" opacity="0.4" />
					<path d="M 63 4 L 65 6 L 63 8" fill="none" stroke="var(--color-text-tertiary)" stroke-width="0.5" opacity="0.4" />
					<circle cx="74" cy="6" r="3" fill="var(--color-success)" opacity="0.6" class="email-pulse" />
					<text x="82" y="9" fill="var(--color-success)" font-size="6.5" font-family="var(--font-mono, monospace)">verified</text>
				</g>
			</g>

			<!-- ═══ Owl watermark ═══ -->
			<g transform="translate(348, 310) scale(0.07)" opacity="0.05">
				<path d="M626.922 872.737c72.812 0 128.59-100.82 154.99-153.92 27.5-55.3 35.6-112.8 23.5-166.8-6.5-29-19.7-56.7-37.8-79.1l-6.7-8.3 5-7.7c10.5-16 19-36.5 23.3-56.5 3.2-14.8 3.2-45.6 0-60.2-3-13.9-6.4-23.9-12.7-37-5.1-10.9-14.9-26.8-18-29.4-2.2-1.8-1.9-3.5 1.3-5.6 4.3-2.8 16-14.4 20.6-20.4 9.4-12.2 15.9-25.9 20.3-42.9 4.5-17.4 4.3-49.1-.4-54.3-2.7-3-5.6-2.1-14.4 4.8-24.5 19.4-49.7 33.9-79.7 46-10.768 4.37-21.834 8.065-33 11.274-4.533 1.303-9.83 2.715-14.475 3.716-2.415.52-6.817 1.408-9.525 1.41-.707 0-1.4-.205-2.088-.368-3.965-.94-10.904-3.28-13.612-4.233-26.2-9.2-50.4-15.1-78.5-19-15.9-2.3-65.9-2.6-82-.6-28.2 3.6-51.6 9-79.1 18.3-4.425 1.46-8.886 2.812-13.35 4.15-.564.17-5.837 1.696-7.35 1.75-1.433.051-5.828-.866-6.738-1.078-3.707-.866-7.41-1.756-11.087-2.747-7.548-2.034-17.17-4.91-24.575-7.575-33.7-12.2-64.6-29-90.3-49.1-10.6-8.3-13-9.3-16.2-7-3.182 2.273-3.746 6.997-4.136 10.542a57 57 0 0 0-.322 3.985c-.415 10.65-.486 21.435 1.158 31.998 1.04 6.674 2.826 13.188 5 19.575 6.9 20.2 21.9 41 37.3 51.4 3.7 2.5 4.6 4.3 2.7 5.5-2 1.2-12.8 18.2-17.3 27.1-5.7 11.4-11.1 26.7-13.9 39.8-3.1 14.5-3.1 43.5 0 58.3 4.5 20.9 12.8 41.1 23.5 57.6l5.4 8.3-4.4 4.9c-6.9 7.7-19.7 27.6-25.8 39.9-16 32.7-23 72.8-19.5 112.6 4.8 54.3 27 107.4 64.6 154.5 11.2 14 38.8 41.6 52.4 52.5 12.3 9.7 30.7 22.1 42.3 28.4" fill="var(--color-brand)" />
			</g>


			<!-- Flow arrowheads -->
			<g transform="translate(218, 186) rotate(0)">
				<path d="M 0 0 L 5 3 L 0 6" fill="none" stroke="var(--color-brand)" stroke-width="1" opacity="0.4" />
			</g>
			<g transform="translate(330, 186) rotate(0)">
				<path d="M 0 0 L 5 3 L 0 6" fill="none" stroke="var(--color-brand)" stroke-width="1" opacity="0.4" />
			</g>
			<g transform="translate(530, 186) rotate(0)">
				<path d="M 0 0 L 5 3 L 0 6" fill="none" stroke="var(--color-brand)" stroke-width="1" opacity="0.4" />
			</g>

			<!-- ═══ Section labels ═══ -->
			<text x="113" y="108" fill="var(--color-text-tertiary)" font-size="8" font-family="var(--font-sans, sans-serif)" text-anchor="middle" letter-spacing="0.05em" opacity="0.6">COMPOSE</text>
			<text x="424" y="136" fill="var(--color-text-tertiary)" font-size="8" font-family="var(--font-sans, sans-serif)" text-anchor="middle" letter-spacing="0.05em" opacity="0.6">TRANSFORM</text>
			<text x="602" y="118" fill="var(--color-text-tertiary)" font-size="8" font-family="var(--font-sans, sans-serif)" text-anchor="middle" letter-spacing="0.05em" opacity="0.6">OUTPUT</text>
			<text x="655" y="274" fill="var(--color-text-tertiary)" font-size="8" font-family="var(--font-sans, sans-serif)" text-anchor="middle" letter-spacing="0.05em" opacity="0.6">DELIVER</text>

			<!-- Top border glow -->
			<rect x="0" y="70" width="800" height="2" rx="1" fill="url(#email-brand-grad)" opacity="0.15" />
		</svg>
	</div>
</template>

<style scoped>
.email-illustration-wrap {
	width: 100%;
	max-width: 800px;
	margin: 2rem auto;
}

.email-illustration {
	width: 100%;
	height: auto;
	border-radius: 16px;
	border: 1px solid var(--color-border-default);
	overflow: hidden;
}

/* ── Pulse ── */
.email-pulse {
	animation: email-pulse-anim 2.5s ease-in-out infinite;
}

@keyframes email-pulse-anim {
	0%, 100% { opacity: 0.6; r: 3; }
	50% { opacity: 1; r: 4; }
}

/* ── Flow path dash animation ── */
.email-flow-path {
	animation: email-dash 3s linear infinite;
}

@keyframes email-dash {
	to { stroke-dashoffset: -24; }
}

/* ── Node entrance ── */
.email-node {
	opacity: 0;
	animation: email-node-in var(--motion-choreo, 800ms) var(--ease-spring, cubic-bezier(0.25, 1, 0.5, 1)) forwards;
}
.email-node-builder { animation-delay: 0.1s; }
.email-node-json { animation-delay: 0.2s; }
.email-node-renderer { animation-delay: 0.35s; }
.email-node-html { animation-delay: 0.45s; }
.email-node-text { animation-delay: 0.5s; }
.email-node-amp { animation-delay: 0.55s; }
.email-node-providers { animation-delay: 0.6s; }
.email-node-dns { animation-delay: 0.7s; }

@keyframes email-node-in {
	from { opacity: 0; transform: translateY(12px); }
	to { opacity: 1; transform: translateY(0); }
}

/* ── Reduced motion ── */
@media (prefers-reduced-motion: reduce) {
	.email-pulse,
	.email-flow-path,
	.email-node {
		animation: none;
		opacity: 1;
	}
}
</style>
