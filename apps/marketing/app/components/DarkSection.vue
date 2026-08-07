<script setup lang="ts">
// Full-width dark module. Scroll-linked entrance (scale 0.9 → 1 with a slight
// fade, reversing on exit) driven by a plain rAF + scroll listener that is
// only attached while the module intersects the viewport. Desktop only;
// disabled under prefers-reduced-motion (mobile and reduced-motion users get
// the flat module).
const wrapper = ref<HTMLElement | null>(null);
const inner = ref<HTMLElement | null>(null);

let rafId = 0;
let observer: IntersectionObserver | null = null;
let listening = false;

function clamp(v: number, min: number, max: number): number {
	return Math.min(Math.max(v, min), max);
}

function update() {
	const wrap = wrapper.value;
	const el = inner.value;
	if (!wrap || !el) return;

	// Measure the untransformed wrapper so the scale never feeds back into
	// its own progress calculation.
	const rect = wrap.getBoundingClientRect();
	const vh = window.innerHeight;
	const enter = clamp((vh - rect.top) / (vh * 0.5), 0, 1);
	const exit = clamp(rect.bottom / (vh * 0.5), 0, 1);
	const p = Math.min(enter, exit);

	el.style.transform = `scale(${(0.9 + 0.1 * p).toFixed(4)})`;
	el.style.opacity = (0.6 + 0.4 * p).toFixed(3);
}

function onScroll() {
	if (rafId) return;
	rafId = requestAnimationFrame(() => {
		rafId = 0;
		update();
	});
}

function attach() {
	if (listening) return;
	listening = true;
	window.addEventListener('scroll', onScroll, { passive: true });
	window.addEventListener('resize', onScroll, { passive: true });
	update();
}

function detach() {
	if (!listening) return;
	listening = false;
	window.removeEventListener('scroll', onScroll);
	window.removeEventListener('resize', onScroll);
}

onMounted(() => {
	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const desktop = window.matchMedia('(min-width: 1024px)').matches;
	if (reducedMotion || !desktop || !wrapper.value) return;

	observer = new IntersectionObserver(
		([entry]) => {
			if (entry?.isIntersecting) attach();
			else detach();
		},
		{ rootMargin: '10% 0px' }
	);
	observer.observe(wrapper.value);
});

onUnmounted(() => {
	observer?.disconnect();
	detach();
	if (rafId) cancelAnimationFrame(rafId);
});
</script>

<template>
	<section ref="wrapper" class="py-6 max-md:py-4 px-8 max-md:px-0">
		<div ref="inner" class="lp-dark max-w-[1200px] mx-auto will-change-transform">
			<slot />
		</div>
	</section>
</template>
