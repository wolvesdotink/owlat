<script setup lang="ts">
/* Animated system map — renders inside <DarkSection>. A looping beat timeline
 * (plain rAF, no libraries) draws the mail-flow edges, ignites nodes via
 * data-state flips (CSS owns all colors), and rides a glowing dot along the
 * drawing head. Paused off-screen and on hidden tabs; reduced-motion and
 * narrow screens get the fully-drawn static diagram. Layout data lives in
 * app/utils/systemMapData.ts. */
import {
	BEAT_MS,
	MAP_BEATS,
	MAP_EDGES,
	MAP_NODES,
	VIEW_H,
	VIEW_W,
	type MapNode,
} from '~/utils/systemMapData';

const root = ref<HTMLElement | null>(null);
const currentBeat = ref(0);
const animated = ref(false);

const TOTAL_MS = BEAT_MS * MAP_BEATS.length;
const DRAW_PORTION = 0.7; // edges draw over the first 70% of their beat

const pathEls = new Map<string, SVGPathElement>();
const dotEls = new Map<string, SVGCircleElement>();
const pathLens = new Map<string, number>();

function setPathEl(id: string, el: unknown) {
	if (el) pathEls.set(id, el as SVGPathElement);
}

function setDotEl(id: string, el: unknown) {
	if (el) dotEls.set(id, el as SVGCircleElement);
}

function nodeState(node: MapNode): 'idle' | 'warm' | 'hot' | 'lit' {
	if (!animated.value) return 'lit';
	const beat = currentBeat.value;
	if (node.beat === beat || node.reigniteBeats?.includes(beat)) return 'hot';
	return node.beat < beat ? 'warm' : 'idle';
}

let rafId = 0;
let startTs = 0;
let frozenT = 0;
let running = false;
let inView = false;
let observer: IntersectionObserver | null = null;

function frame(now: number) {
	const t = (now - startTs) % TOTAL_MS;
	const beat = Math.floor(t / BEAT_MS);
	if (beat !== currentBeat.value) currentBeat.value = beat;
	const p = (t % BEAT_MS) / BEAT_MS;

	for (const edge of MAP_EDGES) {
		const path = pathEls.get(edge.id);
		const dot = dotEls.get(edge.id);
		const len = pathLens.get(edge.id) ?? 0;
		if (!path) continue;

		if (edge.beat < beat) {
			path.style.strokeDashoffset = '0';
			if (dot) dot.style.opacity = '0';
		} else if (edge.beat > beat) {
			path.style.strokeDashoffset = String(len);
			if (dot) dot.style.opacity = '0';
		} else {
			const drawP = Math.min(p / DRAW_PORTION, 1);
			path.style.strokeDashoffset = String(len * (1 - drawP));
			if (dot) {
				if (drawP > 0 && drawP < 1) {
					const pt = path.getPointAtLength(len * drawP);
					dot.setAttribute('cx', pt.x.toFixed(1));
					dot.setAttribute('cy', pt.y.toFixed(1));
					dot.style.opacity = '1';
				} else {
					dot.style.opacity = '0';
				}
			}
		}
	}
	rafId = requestAnimationFrame(frame);
}

function startLoop() {
	if (running || !animated.value) return;
	running = true;
	startTs = performance.now() - frozenT;
	rafId = requestAnimationFrame(frame);
}

function stopLoop() {
	if (!running) return;
	running = false;
	frozenT = (performance.now() - startTs) % TOTAL_MS;
	cancelAnimationFrame(rafId);
}

function syncRunning() {
	if (inView && !document.hidden) startLoop();
	else stopLoop();
}

function onVisibilityChange() {
	syncRunning();
}

function jumpTo(beatIdx: number) {
	currentBeat.value = beatIdx;
	if (!animated.value) return;
	frozenT = beatIdx * BEAT_MS;
	if (running) startTs = performance.now() - frozenT;
}

onMounted(() => {
	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const wide = window.matchMedia('(min-width: 768px)').matches;
	animated.value = !reducedMotion && wide;
	if (!animated.value || !root.value) return;

	// Hide the edges (SSR renders them fully drawn for no-JS), then animate.
	for (const edge of MAP_EDGES) {
		const path = pathEls.get(edge.id);
		if (!path) continue;
		const len = path.getTotalLength();
		pathLens.set(edge.id, len);
		path.style.strokeDasharray = String(len);
		path.style.strokeDashoffset = String(len);
	}

	observer = new IntersectionObserver(
		([entry]) => {
			inView = !!entry?.isIntersecting;
			syncRunning();
		},
		{ threshold: 0.2 }
	);
	observer.observe(root.value);
	document.addEventListener('visibilitychange', onVisibilityChange);
});

onUnmounted(() => {
	observer?.disconnect();
	document.removeEventListener('visibilitychange', onVisibilityChange);
	if (running) cancelAnimationFrame(rafId);
});
</script>

<template>
	<div id="system" ref="root" class="px-12 max-md:px-6 py-20 max-md:py-14">
		<!-- Section header -->
		<div class="text-center flex flex-col items-center">
			<span class="lp-eyebrow mb-4">System</span>
			<h2 class="lp-title mb-4">How mail <span class="lp-title-accent">moves</span></h2>
			<p class="text-base text-text-secondary leading-relaxed max-w-[540px]">
				From queue to inbox — and back. Delivery signals feed the ramp controller, so your sending
				reputation grows instead of guessing.
			</p>
		</div>

		<!-- Accessible description of the flow -->
		<p class="sr-only">
			Diagram of Owlat's mail flow: campaigns, automations and API sends queue on the built-in Owlat
			MTA; messages pass an authentication gate applying DKIM, SPF and DMARC, then reach recipient
			inboxes. Bounce, engagement and placement signals flow back into a ramp controller, which
			adjusts the MTA's sending share and pacing — a continuous deliverability feedback loop.
		</p>

		<!-- Diagram (decorative; described above) -->
		<svg
			:viewBox="`0 0 ${VIEW_W} ${VIEW_H}`"
			class="w-full h-auto mt-12 max-md:mt-8"
			aria-hidden="true"
		>
			<!-- Static track underlays -->
			<path v-for="edge in MAP_EDGES" :key="`track-${edge.id}`" class="map-track" :d="edge.d" />
			<!-- Drawing edges -->
			<path
				v-for="edge in MAP_EDGES"
				:key="edge.id"
				:ref="(el) => setPathEl(edge.id, el)"
				class="map-edge"
				:class="{ 'map-edge-return': edge.ret }"
				:d="edge.d"
			/>
			<!-- Glowing packet dots -->
			<circle
				v-for="edge in MAP_EDGES"
				:key="`dot-${edge.id}`"
				:ref="(el) => setDotEl(edge.id, el)"
				class="map-dot"
				:class="{ 'map-dot-return': edge.ret }"
				r="4"
				cx="-10"
				cy="-10"
				style="opacity: 0"
			/>
			<!-- Nodes -->
			<g v-for="node in MAP_NODES" :key="node.id" class="map-node" :data-state="nodeState(node)">
				<rect :x="node.x" :y="node.y" :width="node.w" :height="node.h" rx="12" />
				<text :x="node.x + node.w / 2" :y="node.y + node.h / 2 - 4" class="map-label">
					{{ node.label }}
				</text>
				<text :x="node.x + node.w / 2" :y="node.y + node.h / 2 + 14" class="map-sub">
					{{ node.sub }}
				</text>
			</g>
		</svg>

		<!-- Beat chips -->
		<div
			class="mt-10 grid grid-cols-5 gap-2.5 max-lg:grid-cols-2 max-md:grid-cols-1"
			role="group"
			aria-label="Mail flow steps"
		>
			<button
				v-for="(beat, i) in MAP_BEATS"
				:key="beat.label"
				type="button"
				class="map-chip"
				:data-active="i === currentBeat"
				:aria-current="i === currentBeat ? 'step' : undefined"
				@click="jumpTo(i)"
			>
				<span class="flex items-center gap-2">
					<span class="font-mono text-2xs text-text-tertiary tabular-nums">0{{ i + 1 }}</span>
					<span class="text-caption font-medium text-text-primary">{{ beat.label }}</span>
				</span>
				<span class="block text-2xs text-text-tertiary leading-[1.5] mt-1">
					{{ beat.caption }}
				</span>
			</button>
		</div>
	</div>
</template>

<style scoped>
/* CSS owns every color; the rAF loop only writes geometry + data-state. */
.map-track {
	fill: none;
	stroke: rgba(255, 255, 255, 0.08);
	stroke-width: 1.5;
}

.map-edge {
	fill: none;
	stroke: rgba(196, 120, 90, 0.65);
	stroke-width: 1.5;
	stroke-linecap: round;
}

.map-edge-return {
	stroke: rgba(212, 165, 116, 0.55);
}

.map-dot {
	fill: rgba(196, 120, 90, 1);
	filter: drop-shadow(0 0 6px rgba(196, 120, 90, 0.9));
}

.map-dot-return {
	fill: rgba(212, 165, 116, 1);
	filter: drop-shadow(0 0 6px rgba(212, 165, 116, 0.9));
}

.map-node rect {
	fill: rgba(255, 255, 255, 0.03);
	stroke: rgba(255, 255, 255, 0.12);
	transition:
		stroke var(--motion-slow) var(--ease-spring),
		filter var(--motion-slow) var(--ease-spring);
}

.map-node[data-state='warm'] rect {
	stroke: rgba(196, 120, 90, 0.45);
}

.map-node[data-state='hot'] rect,
.map-node[data-state='lit'] rect {
	stroke: rgba(196, 120, 90, 0.8);
}

.map-node[data-state='hot'] rect {
	filter: drop-shadow(0 0 10px rgba(196, 120, 90, 0.35));
}

.map-label {
	fill: rgba(255, 255, 255, 0.55);
	font-family: var(--font-mono);
	font-size: 13px;
	font-weight: 500;
	letter-spacing: 0.02em;
	text-anchor: middle;
	transition: fill var(--motion-slow) var(--ease-spring);
}

.map-node[data-state='warm'] .map-label,
.map-node[data-state='hot'] .map-label,
.map-node[data-state='lit'] .map-label {
	fill: #fafafa;
}

.map-sub {
	fill: rgba(255, 255, 255, 0.38);
	font-family: var(--font-sans);
	font-size: 10px;
	text-anchor: middle;
}

/* Beat chips — dark-module token overrides already give text-text-* the
 * white scales; only the active accent lives here. */
.map-chip {
	text-align: left;
	border: 1px solid var(--color-border-subtle);
	border-radius: 12px;
	background: transparent;
	padding: 0.625rem 0.875rem;
	cursor: pointer;
	transition:
		border-color var(--motion-fast) var(--ease-spring),
		background-color var(--motion-fast) var(--ease-spring);
}

.map-chip:hover {
	border-color: var(--color-border-default);
}

.map-chip[data-active='true'] {
	border-color: rgba(196, 120, 90, 0.6);
	background: rgba(196, 120, 90, 0.08);
}
</style>
