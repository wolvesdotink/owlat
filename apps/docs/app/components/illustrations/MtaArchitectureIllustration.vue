<script setup lang="ts">
const props = withDefaults(defineProps<{ class?: string }>(), { class: '' })
</script>

<template>
	<div :class="['mta-illustration-wrap', props.class]" aria-hidden="true">
		<svg
			viewBox="0 40 920 480"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			class="mta-illustration"
			preserveAspectRatio="xMidYMid meet"
		>
			<defs>
				<!-- Gradients -->
				<linearGradient id="mta-brand-grad" x1="0%" y1="0%" x2="100%" y2="100%">
					<stop offset="0%" stop-color="var(--color-brand, #c4785a)" />
					<stop offset="100%" stop-color="var(--color-accent, #d4a574)" />
				</linearGradient>
				<linearGradient id="mta-flow-grad" x1="0%" y1="0%" x2="100%" y2="0%">
					<stop offset="0%" stop-color="var(--color-brand, #c4785a)" stop-opacity="0.5" />
					<stop offset="50%" stop-color="var(--color-accent, #d4a574)" stop-opacity="0.3" />
					<stop offset="100%" stop-color="var(--color-brand, #c4785a)" stop-opacity="0.1" />
				</linearGradient>
				<linearGradient id="mta-surface-grad" x1="0%" y1="0%" x2="0%" y2="100%">
					<stop offset="0%" stop-color="var(--color-bg-surface, #1c1916)" />
					<stop offset="100%" stop-color="var(--color-bg-elevated, #141210)" />
				</linearGradient>
				<radialGradient id="mta-orb-1" cx="50%" cy="50%" r="50%">
					<stop offset="0%" stop-color="var(--color-brand, #c4785a)" stop-opacity="0.1" />
					<stop offset="100%" stop-color="var(--color-brand, #c4785a)" stop-opacity="0" />
				</radialGradient>
				<radialGradient id="mta-orb-2" cx="50%" cy="50%" r="50%">
					<stop offset="0%" stop-color="var(--color-accent, #d4a574)" stop-opacity="0.07" />
					<stop offset="100%" stop-color="var(--color-accent, #d4a574)" stop-opacity="0" />
				</radialGradient>
				<radialGradient id="mta-center-glow" cx="50%" cy="50%" r="50%">
					<stop offset="0%" stop-color="var(--color-brand, #c4785a)" stop-opacity="0.06" />
					<stop offset="100%" stop-color="var(--color-brand, #c4785a)" stop-opacity="0" />
				</radialGradient>

				<!-- Filters -->
				<filter id="mta-shadow" x="-20%" y="-20%" width="140%" height="140%">
					<feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#000" flood-opacity="0.3" />
				</filter>
				<filter id="mta-glow" x="-50%" y="-50%" width="200%" height="200%">
					<feGaussianBlur in="SourceGraphic" stdDeviation="6" />
				</filter>

				<!-- Dot pattern -->
				<pattern id="mta-dots" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
					<circle cx="1" cy="1" r="0.5" fill="var(--color-text-tertiary, #5c564e)" opacity="0.12" />
				</pattern>
			</defs>

			<!-- Background -->
			<rect y="40" width="920" height="480" rx="16" fill="var(--color-bg-elevated, #141210)" />
			<rect y="40" width="920" height="480" rx="16" fill="url(#mta-dots)" />

			<!-- Ambient orbs -->
			<circle cx="140" cy="140" r="100" fill="url(#mta-orb-1)" class="mta-orb mta-orb-1" />
			<circle cx="780" cy="280" r="90" fill="url(#mta-orb-2)" class="mta-orb mta-orb-2" />
			<circle cx="460" cy="200" r="140" fill="url(#mta-center-glow)" class="mta-orb mta-orb-3" />

			<!-- ═══ Flow paths (main pipeline) ═══ -->
			<!-- API → Queue -->
			<path
				d="M 138 180 L 186 180"
				stroke="var(--color-brand, #c4785a)"
				stroke-width="1.5"
				stroke-dasharray="5 4"
				stroke-opacity="0.45"
				class="mta-flow-path"
			/>
			<!-- Queue → Intelligence -->
			<path
				d="M 330 180 L 376 180"
				stroke="var(--color-brand, #c4785a)"
				stroke-width="1.5"
				stroke-dasharray="5 4"
				stroke-opacity="0.45"
				class="mta-flow-path"
			/>
			<!-- Intelligence → SMTP -->
			<path
				d="M 558 180 L 606 180"
				stroke="var(--color-brand, #c4785a)"
				stroke-width="1.5"
				stroke-dasharray="5 4"
				stroke-opacity="0.45"
				class="mta-flow-path"
			/>
			<!-- SMTP → Delivered -->
			<path
				d="M 748 155 C 778 150, 790 135, 810 130"
				stroke="var(--color-success, #7a9b6e)"
				stroke-width="1"
				stroke-dasharray="3 5"
				stroke-opacity="0.5"
				class="mta-flow-path"
			/>
			<!-- SMTP → Bounced -->
			<path
				d="M 748 175 C 778 175, 790 175, 810 175"
				stroke="var(--color-error, #c45a5a)"
				stroke-width="1"
				stroke-dasharray="3 5"
				stroke-opacity="0.5"
				class="mta-flow-path"
			/>
			<!-- SMTP → Deferred -->
			<path
				d="M 748 195 C 778 200, 790 215, 810 220"
				stroke="var(--color-warning, #c9a55a)"
				stroke-width="1"
				stroke-dasharray="3 5"
				stroke-opacity="0.5"
				class="mta-flow-path"
			/>

			<!-- Deferred → back to Queue (curved loop) -->
			<path
				d="M 870 238 C 885 268, 870 290, 830 300 C 750 320, 350 310, 264 280 C 240 272, 240 255, 248 240"
				stroke="var(--color-warning, #c9a55a)"
				stroke-width="1"
				stroke-dasharray="4 6"
				stroke-opacity="0.3"
				fill="none"
				class="mta-flow-path"
			/>
			<!-- Loop arrow tip -->
			<g transform="translate(245, 237) rotate(-60)">
				<path d="M 0 0 L 5 3 L 0 6" fill="none" stroke="var(--color-warning, #c9a55a)" stroke-width="0.8" opacity="0.4" />
			</g>

			<!-- Webhook path from outcomes down to Convex -->
			<path
				d="M 850 150 C 870 175, 885 240, 870 330 C 858 380, 680 400, 595 405"
				stroke="var(--color-accent, #d4a574)"
				stroke-width="1"
				stroke-dasharray="3 6"
				stroke-opacity="0.25"
				fill="none"
				class="mta-flow-path"
			/>

			<!-- Bounce loop flow paths -->
			<!-- Inbound → Parse -->
			<path
				d="M 168 430 C 186 430, 198 430, 216 430"
				stroke="var(--color-brand, #c4785a)"
				stroke-width="1"
				stroke-dasharray="3 5"
				stroke-opacity="0.35"
				class="mta-flow-path"
			/>
			<!-- Parse → Classify -->
			<path
				d="M 348 430 C 366 430, 378 430, 396 430"
				stroke="var(--color-brand, #c4785a)"
				stroke-width="1"
				stroke-dasharray="3 5"
				stroke-opacity="0.35"
				class="mta-flow-path"
			/>
			<!-- Classify → Convex webhook -->
			<path
				d="M 528 430 C 538 425, 548 415, 558 410"
				stroke="var(--color-accent, #d4a574)"
				stroke-width="1"
				stroke-dasharray="3 5"
				stroke-opacity="0.3"
				class="mta-flow-path"
			/>

			<!-- ═══ Flow arrowheads ═══ -->
			<g transform="translate(186, 175)">
				<path d="M 0 0 L 7 5 L 0 10" fill="none" stroke="var(--color-brand, #c4785a)" stroke-width="1.3" opacity="0.6" />
			</g>
			<g transform="translate(376, 175)">
				<path d="M 0 0 L 7 5 L 0 10" fill="none" stroke="var(--color-brand, #c4785a)" stroke-width="1.3" opacity="0.6" />
			</g>
			<g transform="translate(606, 175)">
				<path d="M 0 0 L 7 5 L 0 10" fill="none" stroke="var(--color-brand, #c4785a)" stroke-width="1.3" opacity="0.6" />
			</g>

			<!-- ═══ Section labels ═══ -->
			<text x="84" y="78" fill="var(--color-text-tertiary, #5c564e)" font-size="8" font-family="var(--font-sans, sans-serif)" text-anchor="middle" letter-spacing="0.05em" opacity="0.6">INGEST</text>
			<text x="264" y="78" fill="var(--color-text-tertiary, #5c564e)" font-size="8" font-family="var(--font-sans, sans-serif)" text-anchor="middle" letter-spacing="0.05em" opacity="0.6">QUEUE</text>
			<text x="473" y="78" fill="var(--color-text-tertiary, #5c564e)" font-size="8" font-family="var(--font-sans, sans-serif)" text-anchor="middle" letter-spacing="0.05em" opacity="0.6">DECIDE</text>
			<text x="683" y="78" fill="var(--color-text-tertiary, #5c564e)" font-size="8" font-family="var(--font-sans, sans-serif)" text-anchor="middle" letter-spacing="0.05em" opacity="0.6">SEND</text>
			<text x="856" y="78" fill="var(--color-text-tertiary, #5c564e)" font-size="8" font-family="var(--font-sans, sans-serif)" text-anchor="middle" letter-spacing="0.05em" opacity="0.6">OUTCOME</text>
			<text x="290" y="390" fill="var(--color-text-tertiary, #5c564e)" font-size="8" font-family="var(--font-sans, sans-serif)" text-anchor="middle" letter-spacing="0.05em" opacity="0.6">BOUNCE LOOP</text>

			<!-- ═══ API Request Node ═══ -->
			<g class="mta-node mta-node-api" filter="url(#mta-shadow)">
				<rect x="24" y="100" width="114" height="170" rx="12" fill="url(#mta-surface-grad)" stroke="var(--color-border-default, #262320)" stroke-width="1" />
				<rect x="24" y="100" width="114" height="3" rx="1.5" fill="url(#mta-brand-grad)" opacity="0.7" />

				<!-- Envelope icon -->
				<g transform="translate(58, 120)">
					<rect width="24" height="18" rx="3" stroke="var(--color-accent, #d4a574)" stroke-width="1.2" fill="none" />
					<path d="M 0 3 L 12 12 L 24 3" stroke="var(--color-accent, #d4a574)" stroke-width="1" fill="none" />
				</g>
				<text x="81" y="156" fill="var(--color-text-primary, #f0ece6)" font-size="10" font-weight="600" font-family="var(--font-sans, sans-serif)" text-anchor="middle">API Request</text>

				<!-- Endpoint badges -->
				<g transform="translate(38, 168)">
					<rect width="86" height="16" rx="3" fill="var(--color-brand, #c4785a)" fill-opacity="0.08" />
					<text x="6" y="11" fill="var(--color-brand, #c4785a)" font-size="7" font-family="var(--font-mono, monospace)">POST /send</text>
				</g>
				<g transform="translate(38, 188)">
					<rect width="86" height="16" rx="3" fill="var(--color-info, #6b8fa8)" fill-opacity="0.08" />
					<text x="6" y="11" fill="var(--color-info, #6b8fa8)" font-size="7" font-family="var(--font-mono, monospace)">Bearer token</text>
				</g>

				<text x="81" y="244" fill="var(--color-text-tertiary, #5c564e)" font-size="7" font-family="var(--font-mono, monospace)" text-anchor="middle">Hono HTTP</text>
			</g>

			<!-- ═══ GroupMQ / Redis Node ═══ -->
			<g class="mta-node mta-node-queue" filter="url(#mta-shadow)">
				<rect x="198" y="100" width="132" height="170" rx="12" fill="url(#mta-surface-grad)" stroke="var(--color-border-default, #262320)" stroke-width="1" />
				<rect x="198" y="100" width="132" height="3" rx="1.5" fill="url(#mta-brand-grad)" opacity="0.5" />

				<!-- Redis diamond icon -->
				<g transform="translate(242, 118)">
					<path d="M 12 0 L 24 8 L 12 16 L 0 8 Z" fill="var(--color-error, #c45a5a)" fill-opacity="0.2" stroke="var(--color-error, #c45a5a)" stroke-width="0.8" />
					<path d="M 12 4 L 18 8 L 12 12 L 6 8 Z" fill="var(--color-error, #c45a5a)" fill-opacity="0.4" />
				</g>
				<text x="264" y="152" fill="var(--color-text-primary, #f0ece6)" font-size="10" font-weight="600" font-family="var(--font-sans, sans-serif)" text-anchor="middle">GroupMQ / Redis</text>

				<!-- Group key badge -->
				<g transform="translate(212, 162)">
					<rect width="104" height="16" rx="3" fill="var(--color-bg-soft, #181614)" />
					<text x="6" y="11" fill="var(--color-text-secondary, #968e84)" font-size="6.5" font-family="var(--font-mono, monospace)">group: pool:domain</text>
				</g>

				<!-- Concurrency badge -->
				<g transform="translate(212, 184)">
					<rect width="104" height="16" rx="3" fill="var(--color-brand, #c4785a)" fill-opacity="0.08" />
					<text x="6" y="11" fill="var(--color-brand, #c4785a)" font-size="6.5" font-family="var(--font-mono, monospace)">50 concurrent</text>
				</g>

				<!-- Backoff badge -->
				<g transform="translate(212, 206)">
					<rect width="104" height="16" rx="3" fill="var(--color-warning, #c9a55a)" fill-opacity="0.08" />
					<text x="6" y="11" fill="var(--color-warning, #c9a55a)" font-size="6.5" font-family="var(--font-mono, monospace)">exp. backoff</text>
				</g>

				<text x="264" y="244" fill="var(--color-text-tertiary, #5c564e)" font-size="7" font-family="var(--font-mono, monospace)" text-anchor="middle">FIFO per group</text>
			</g>

			<!-- ═══ Intelligence Pipeline Node (central, largest) ═══ -->
			<g class="mta-node mta-node-intel" filter="url(#mta-shadow)">
				<!-- Glow -->
				<ellipse cx="473" cy="180" rx="90" ry="65" fill="var(--color-brand, #c4785a)" opacity="0.04" filter="url(#mta-glow)" />
				<rect x="388" y="90" width="170" height="190" rx="14" fill="url(#mta-surface-grad)" stroke="var(--color-brand, #c4785a)" stroke-width="1" stroke-opacity="0.4" />

				<!-- Header -->
				<text x="473" y="114" fill="var(--color-text-primary, #f0ece6)" font-size="10" font-weight="600" font-family="var(--font-sans, sans-serif)" text-anchor="middle">Intelligence Pipeline</text>

				<!-- 6 check rows -->
				<g transform="translate(400, 124)">
					<!-- 1. Circuit Breaker -->
					<g transform="translate(0, 0)">
						<circle cx="8" cy="8" r="3.5" fill="var(--color-error, #c45a5a)" fill-opacity="0.15" stroke="var(--color-error, #c45a5a)" stroke-width="0.6" />
						<text x="18" y="11" fill="var(--color-text-secondary, #968e84)" font-size="7" font-family="var(--font-mono, monospace)">Circuit Breaker</text>
					</g>
					<!-- 2. Domain Throttle -->
					<g transform="translate(0, 22)">
						<circle cx="8" cy="8" r="3.5" fill="var(--color-warning, #c9a55a)" fill-opacity="0.15" stroke="var(--color-warning, #c9a55a)" stroke-width="0.6" />
						<text x="18" y="11" fill="var(--color-text-secondary, #968e84)" font-size="7" font-family="var(--font-mono, monospace)">Domain Throttle</text>
					</g>
					<!-- 3. SMTP Intel -->
					<g transform="translate(0, 44)">
						<circle cx="8" cy="8" r="3.5" fill="var(--color-info, #6b8fa8)" fill-opacity="0.15" stroke="var(--color-info, #6b8fa8)" stroke-width="0.6" />
						<text x="18" y="11" fill="var(--color-text-secondary, #968e84)" font-size="7" font-family="var(--font-mono, monospace)">SMTP Intel</text>
					</g>
					<!-- 4. DNSBL Check -->
					<g transform="translate(0, 66)">
						<circle cx="8" cy="8" r="3.5" fill="var(--color-brand, #c4785a)" fill-opacity="0.15" stroke="var(--color-brand, #c4785a)" stroke-width="0.6" />
						<text x="18" y="11" fill="var(--color-text-secondary, #968e84)" font-size="7" font-family="var(--font-mono, monospace)">DNSBL Check</text>
					</g>
					<!-- 5. Warming Cap -->
					<g transform="translate(0, 88)">
						<circle cx="8" cy="8" r="3.5" fill="var(--color-accent, #d4a574)" fill-opacity="0.15" stroke="var(--color-accent, #d4a574)" stroke-width="0.6" />
						<text x="18" y="11" fill="var(--color-text-secondary, #968e84)" font-size="7" font-family="var(--font-mono, monospace)">Warming Cap</text>
					</g>
					<!-- 6. IP Selection -->
					<g transform="translate(0, 110)">
						<circle cx="8" cy="8" r="3.5" fill="var(--color-success, #7a9b6e)" fill-opacity="0.15" stroke="var(--color-success, #7a9b6e)" stroke-width="0.6" />
						<text x="18" y="11" fill="var(--color-text-secondary, #968e84)" font-size="7" font-family="var(--font-mono, monospace)">IP Selection</text>
					</g>
				</g>

				<text x="473" y="264" fill="var(--color-text-tertiary, #5c564e)" font-size="7" font-family="var(--font-mono, monospace)" text-anchor="middle">8 pre-send checks</text>
			</g>

			<!-- ═══ SMTP Delivery Node ═══ -->
			<g class="mta-node mta-node-smtp" filter="url(#mta-shadow)">
				<rect x="618" y="100" width="130" height="170" rx="12" fill="url(#mta-surface-grad)" stroke="var(--color-border-default, #262320)" stroke-width="1" />
				<rect x="618" y="100" width="130" height="3" rx="1.5" fill="url(#mta-brand-grad)" opacity="0.5" />

				<!-- Envelope + arrow icon -->
				<g transform="translate(662, 118)">
					<rect width="18" height="13" rx="2" stroke="var(--color-accent, #d4a574)" stroke-width="1" fill="none" />
					<path d="M 0 2 L 9 9 L 18 2" stroke="var(--color-accent, #d4a574)" stroke-width="0.8" fill="none" />
					<path d="M 22 4 L 30 4" stroke="var(--color-brand, #c4785a)" stroke-width="1.2" />
					<path d="M 27 1 L 30 4 L 27 7" fill="none" stroke="var(--color-brand, #c4785a)" stroke-width="1" />
				</g>
				<text x="683" y="152" fill="var(--color-text-primary, #f0ece6)" font-size="10" font-weight="600" font-family="var(--font-sans, sans-serif)" text-anchor="middle">SMTP Delivery</text>

				<!-- Feature badges -->
				<g transform="translate(632, 162)">
					<rect width="102" height="16" rx="3" fill="var(--color-brand, #c4785a)" fill-opacity="0.08" />
					<text x="6" y="11" fill="var(--color-brand, #c4785a)" font-size="7" font-family="var(--font-mono, monospace)">MX Resolution</text>
				</g>
				<g transform="translate(632, 184)">
					<rect width="102" height="16" rx="3" fill="var(--color-info, #6b8fa8)" fill-opacity="0.08" />
					<text x="6" y="11" fill="var(--color-info, #6b8fa8)" font-size="7" font-family="var(--font-mono, monospace)">DKIM Signing</text>
				</g>
				<g transform="translate(632, 206)">
					<rect width="102" height="16" rx="3" fill="var(--color-accent, #d4a574)" fill-opacity="0.08" />
					<text x="6" y="11" fill="var(--color-accent, #d4a574)" font-size="7" font-family="var(--font-mono, monospace)">VERP Return-Path</text>
				</g>
				<g transform="translate(632, 228)">
					<rect width="102" height="16" rx="3" fill="var(--color-success, #7a9b6e)" fill-opacity="0.08" />
					<text x="6" y="11" fill="var(--color-success, #7a9b6e)" font-size="7" font-family="var(--font-mono, monospace)">Port 25 direct</text>
				</g>

				<text x="683" y="260" fill="var(--color-text-tertiary, #5c564e)" font-size="7" font-family="var(--font-mono, monospace)" text-anchor="middle">nodemailer</text>
			</g>

			<!-- ═══ Outcome Nodes ═══ -->
			<!-- Delivered -->
			<g class="mta-node mta-node-delivered">
				<rect x="810" y="106" width="86" height="38" rx="8" fill="var(--color-bg-surface, #1c1916)" stroke="var(--color-success, #7a9b6e)" stroke-width="0.8" stroke-opacity="0.5" />
				<circle cx="826" cy="125" r="4" fill="var(--color-success, #7a9b6e)" opacity="0.5" class="mta-pulse" />
				<text x="836" y="129" fill="var(--color-success, #7a9b6e)" font-size="8" font-weight="600" font-family="var(--font-mono, monospace)">Delivered</text>
			</g>

			<!-- Bounced -->
			<g class="mta-node mta-node-bounced">
				<rect x="810" y="152" width="86" height="38" rx="8" fill="var(--color-bg-surface, #1c1916)" stroke="var(--color-error, #c45a5a)" stroke-width="0.8" stroke-opacity="0.5" />
				<circle cx="826" cy="171" r="4" fill="var(--color-error, #c45a5a)" opacity="0.5" />
				<text x="836" y="175" fill="var(--color-error, #c45a5a)" font-size="8" font-weight="600" font-family="var(--font-mono, monospace)">Bounced</text>
			</g>

			<!-- Deferred -->
			<g class="mta-node mta-node-deferred">
				<rect x="810" y="198" width="86" height="38" rx="8" fill="var(--color-bg-surface, #1c1916)" stroke="var(--color-warning, #c9a55a)" stroke-width="0.8" stroke-opacity="0.5" />
				<circle cx="826" cy="217" r="4" fill="var(--color-warning, #c9a55a)" opacity="0.5" />
				<text x="836" y="221" fill="var(--color-warning, #c9a55a)" font-size="8" font-weight="600" font-family="var(--font-mono, monospace)">Deferred</text>
			</g>

			<!-- Retry label on deferred loop -->
			<text x="560" y="308" fill="var(--color-warning, #c9a55a)" font-size="6.5" font-family="var(--font-mono, monospace)" opacity="0.4">retry with backoff</text>

			<!-- ═══ Convex Webhook Node ═══ -->
			<g class="mta-node mta-node-convex" filter="url(#mta-shadow)">
				<!-- Outer container with accent glow -->
				<rect x="558" y="378" width="134" height="68" rx="12" fill="url(#mta-surface-grad)" stroke="var(--color-accent, #d4a574)" stroke-width="1" stroke-opacity="0.35" />
				<!-- Subtle top accent bar -->
				<rect x="558" y="378" width="134" height="2.5" rx="1.2" fill="var(--color-accent, #d4a574)" opacity="0.4" />

				<!-- Header row: icon + title centered -->
				<text x="625" y="400" fill="var(--color-text-primary, #f0ece6)" font-size="10" font-weight="600" font-family="var(--font-sans, sans-serif)" text-anchor="middle">Webhook</text>

				<!-- Destination badge -->
				<g transform="translate(588, 406)">
					<rect width="74" height="14" rx="4" fill="var(--color-accent, #d4a574)" fill-opacity="0.1" />
					<text x="37" y="10" fill="var(--color-accent, #d4a574)" font-size="6.5" font-family="var(--font-mono, monospace)" text-anchor="middle">→ Convex API</text>
				</g>

				<!-- Event type pills -->
				<g transform="translate(572, 425)">
					<rect width="32" height="12" rx="6" fill="var(--color-success, #7a9b6e)" fill-opacity="0.12" />
					<text x="16" y="9" fill="var(--color-success, #7a9b6e)" font-size="5.5" font-family="var(--font-mono, monospace)" text-anchor="middle">sent</text>
				</g>
				<g transform="translate(608, 425)">
					<rect width="42" height="12" rx="6" fill="var(--color-error, #c45a5a)" fill-opacity="0.12" />
					<text x="21" y="9" fill="var(--color-error, #c45a5a)" font-size="5.5" font-family="var(--font-mono, monospace)" text-anchor="middle">bounced</text>
				</g>
				<g transform="translate(654, 425)">
					<rect width="28" height="12" rx="6" fill="var(--color-warning, #c9a55a)" fill-opacity="0.12" />
					<text x="14" y="9" fill="var(--color-warning, #c9a55a)" font-size="5.5" font-family="var(--font-mono, monospace)" text-anchor="middle">FBL</text>
				</g>
			</g>

			<!-- ═══ Bounce Loop Nodes ═══ -->
			<!-- Inbound SMTP -->
			<g class="mta-node mta-node-inbound">
				<rect x="48" y="405" width="120" height="50" rx="8" fill="var(--color-bg-surface, #1c1916)" stroke="var(--color-border-default, #262320)" stroke-width="0.7" />
				<!-- Incoming envelope icon (left side, vertically centered) -->
				<g transform="translate(62, 425)">
					<rect width="14" height="10" rx="1.5" stroke="var(--color-brand, #c4785a)" stroke-width="0.8" fill="none" />
					<path d="M 0 1.5 L 7 7 L 14 1.5" stroke="var(--color-brand, #c4785a)" stroke-width="0.6" fill="none" />
					<!-- Downward arrow indicating inbound -->
					<path d="M 7 -6 L 7 -1" stroke="var(--color-brand, #c4785a)" stroke-width="1" opacity="0.6" />
					<path d="M 4.5 -3 L 7 -0.5 L 9.5 -3" fill="none" stroke="var(--color-brand, #c4785a)" stroke-width="0.8" opacity="0.6" />
				</g>
				<text x="84" y="427" fill="var(--color-text-primary, #f0ece6)" font-size="8" font-weight="600" font-family="var(--font-sans, sans-serif)">Inbound SMTP</text>
				<text x="84" y="440" fill="var(--color-text-tertiary, #5c564e)" font-size="6.5" font-family="var(--font-mono, monospace)">VERP decode</text>
			</g>

			<!-- DSN Parse -->
			<g class="mta-node mta-node-parse">
				<rect x="228" y="405" width="120" height="50" rx="8" fill="var(--color-bg-surface, #1c1916)" stroke="var(--color-border-default, #262320)" stroke-width="0.7" />
				<text x="288" y="425" fill="var(--color-text-primary, #f0ece6)" font-size="8" font-weight="600" font-family="var(--font-sans, sans-serif)" text-anchor="middle">DSN Parse</text>
				<text x="288" y="440" fill="var(--color-text-tertiary, #5c564e)" font-size="6.5" font-family="var(--font-mono, monospace)" text-anchor="middle">RFC 3464 + ARF</text>
			</g>

			<!-- Classify -->
			<g class="mta-node mta-node-classify">
				<rect x="408" y="405" width="120" height="50" rx="8" fill="var(--color-bg-surface, #1c1916)" stroke="var(--color-border-default, #262320)" stroke-width="0.7" />
				<text x="468" y="425" fill="var(--color-text-primary, #f0ece6)" font-size="8" font-weight="600" font-family="var(--font-sans, sans-serif)" text-anchor="middle">Classify</text>
				<text x="468" y="440" fill="var(--color-text-tertiary, #5c564e)" font-size="6.5" font-family="var(--font-mono, monospace)" text-anchor="middle">hard / soft / complaint</text>
			</g>

			<!-- Bounce loop arrowheads -->
			<g transform="translate(216, 425)">
				<path d="M 0 0 L 6 4 L 0 8" fill="none" stroke="var(--color-brand, #c4785a)" stroke-width="1" opacity="0.45" />
			</g>
			<g transform="translate(396, 425)">
				<path d="M 0 0 L 6 4 L 0 8" fill="none" stroke="var(--color-brand, #c4785a)" stroke-width="1" opacity="0.45" />
			</g>

			<!-- ═══ Owl watermark ═══ -->
			<g transform="translate(818, 420) scale(0.055)" opacity="0.04">
				<path d="M626.922 872.737c72.812 0 128.59-100.82 154.99-153.92 27.5-55.3 35.6-112.8 23.5-166.8-6.5-29-19.7-56.7-37.8-79.1l-6.7-8.3 5-7.7c10.5-16 19-36.5 23.3-56.5 3.2-14.8 3.2-45.6 0-60.2-3-13.9-6.4-23.9-12.7-37-5.1-10.9-14.9-26.8-18-29.4-2.2-1.8-1.9-3.5 1.3-5.6 4.3-2.8 16-14.4 20.6-20.4 9.4-12.2 15.9-25.9 20.3-42.9 4.5-17.4 4.3-49.1-.4-54.3-2.7-3-5.6-2.1-14.4 4.8-24.5 19.4-49.7 33.9-79.7 46-10.768 4.37-21.834 8.065-33 11.274-4.533 1.303-9.83 2.715-14.475 3.716-2.415.52-6.817 1.408-9.525 1.41-.707 0-1.4-.205-2.088-.368-3.965-.94-10.904-3.28-13.612-4.233-26.2-9.2-50.4-15.1-78.5-19-15.9-2.3-65.9-2.6-82-.6-28.2 3.6-51.6 9-79.1 18.3-4.425 1.46-8.886 2.812-13.35 4.15-.564.17-5.837 1.696-7.35 1.75-1.433.051-5.828-.866-6.738-1.078-3.707-.866-7.41-1.756-11.087-2.747-7.548-2.034-17.17-4.91-24.575-7.575-33.7-12.2-64.6-29-90.3-49.1-10.6-8.3-13-9.3-16.2-7-3.182 2.273-3.746 6.997-4.136 10.542a57 57 0 0 0-.322 3.985c-.415 10.65-.486 21.435 1.158 31.998 1.04 6.674 2.826 13.188 5 19.575 6.9 20.2 21.9 41 37.3 51.4 3.7 2.5 4.6 4.3 2.7 5.5-2 1.2-12.8 18.2-17.3 27.1-5.7 11.4-11.1 26.7-13.9 39.8-3.1 14.5-3.1 43.5 0 58.3 4.5 20.9 12.8 41.1 23.5 57.6l5.4 8.3-4.4 4.9c-6.9 7.7-19.7 27.6-25.8 39.9-16 32.7-23 72.8-19.5 112.6 4.8 54.3 27 107.4 64.6 154.5 11.2 14 38.8 41.6 52.4 52.5 12.3 9.7 30.7 22.1 42.3 28.4" fill="var(--color-brand, #c4785a)" />
			</g>

			<!-- ═══ Floating particles ═══ -->
			<circle cx="170" cy="160" r="1.5" fill="var(--color-brand, #c4785a)" opacity="0.3" class="mta-particle mta-ep1" />
			<circle cx="360" cy="140" r="1" fill="var(--color-accent, #d4a574)" opacity="0.25" class="mta-particle mta-ep2" />
			<circle cx="580" cy="200" r="2" fill="var(--color-brand, #c4785a)" opacity="0.2" class="mta-particle mta-ep3" />
			<circle cx="770" cy="160" r="1.5" fill="var(--color-accent, #d4a574)" opacity="0.2" class="mta-particle mta-ep4" />
			<circle cx="440" cy="360" r="1" fill="var(--color-brand, #c4785a)" opacity="0.15" class="mta-particle mta-ep5" />

			<!-- Top border glow -->
			<rect x="0" y="40" width="920" height="2" rx="1" fill="url(#mta-brand-grad)" opacity="0.15" />
		</svg>
	</div>
</template>

<style scoped>
.mta-illustration-wrap {
	width: 100%;
	max-width: 920px;
	margin: 2rem auto;
}

.mta-illustration {
	width: 100%;
	height: auto;
	border-radius: 16px;
	border: 1px solid var(--color-border-default, #262320);
	overflow: hidden;
}

/* ── Floating orbs ── */
.mta-orb-1 {
	animation: mta-drift 20s ease-in-out infinite;
}
.mta-orb-2 {
	animation: mta-drift-rev 24s ease-in-out infinite;
}
.mta-orb-3 {
	animation: mta-drift 18s ease-in-out infinite 3s;
}

@keyframes mta-drift {
	0%, 100% { transform: translate(0, 0); }
	33% { transform: translate(10px, -7px); }
	66% { transform: translate(-7px, 5px); }
}

@keyframes mta-drift-rev {
	0%, 100% { transform: translate(0, 0); }
	33% { transform: translate(-8px, 5px); }
	66% { transform: translate(6px, -4px); }
}

/* ── Pulse (delivered indicator) ── */
.mta-pulse {
	animation: mta-pulse-anim 2.5s ease-in-out infinite;
}

@keyframes mta-pulse-anim {
	0%, 100% { opacity: 0.5; r: 4; }
	50% { opacity: 1; r: 5; }
}

/* ── Flow path dash animation ── */
.mta-flow-path {
	animation: mta-dash 3s linear infinite;
}

@keyframes mta-dash {
	to { stroke-dashoffset: -24; }
}

/* ── Particles ── */
.mta-ep1 { animation: mta-p-float 6s ease-in-out infinite; }
.mta-ep2 { animation: mta-p-float 7s ease-in-out infinite 1s; }
.mta-ep3 { animation: mta-p-float 5.5s ease-in-out infinite 2s; }
.mta-ep4 { animation: mta-p-float 8s ease-in-out infinite 0.5s; }
.mta-ep5 { animation: mta-p-float 9s ease-in-out infinite 1.5s; }

@keyframes mta-p-float {
	0%, 100% { transform: translate(0, 0); opacity: 0.25; }
	25% { transform: translate(3px, -4px); opacity: 0.4; }
	50% { transform: translate(-2px, -6px); opacity: 0.15; }
	75% { transform: translate(4px, -2px); opacity: 0.35; }
}

/* ── Node entrance ── */
.mta-node {
	opacity: 0;
	animation: mta-node-in 0.8s var(--ease-out-expo, cubic-bezier(0.16, 1, 0.3, 1)) forwards;
}
.mta-node-api { animation-delay: 0.1s; }
.mta-node-queue { animation-delay: 0.2s; }
.mta-node-intel { animation-delay: 0.35s; }
.mta-node-smtp { animation-delay: 0.5s; }
.mta-node-delivered { animation-delay: 0.6s; }
.mta-node-bounced { animation-delay: 0.65s; }
.mta-node-deferred { animation-delay: 0.7s; }
.mta-node-convex { animation-delay: 0.75s; }
.mta-node-inbound { animation-delay: 0.8s; }
.mta-node-parse { animation-delay: 0.85s; }
.mta-node-classify { animation-delay: 0.9s; }

@keyframes mta-node-in {
	from { opacity: 0; transform: translateY(12px); }
	to { opacity: 1; transform: translateY(0); }
}

/* ── Reduced motion ── */
@media (prefers-reduced-motion: reduce) {
	.mta-orb-1, .mta-orb-2, .mta-orb-3,
	.mta-pulse, .mta-flow-path,
	.mta-ep1, .mta-ep2, .mta-ep3, .mta-ep4, .mta-ep5,
	.mta-node {
		animation: none;
		opacity: 1;
	}
}
</style>
