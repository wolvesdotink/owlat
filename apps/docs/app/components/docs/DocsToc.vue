<template>
	<nav v-if="headings.length" class="toc" :aria-label="t('toc.label')">
		<h4 class="text-2xs font-medium uppercase tracking-widest text-text-tertiary px-2">
			{{ t('toc.title') }}
		</h4>
		<ul class="toc-list">
			<li v-for="heading in headings" :key="heading.id">
				<a
					:href="`#${heading.id}`"
					class="toc-link"
					:class="[heading.level === 3 ? 'toc-h3' : 'toc-h2', { active: activeId === heading.id }]"
					@click.prevent="scrollToHeading(heading.id)"
				>
					{{ heading.text }}
				</a>
			</li>
		</ul>
	</nav>
</template>

<script setup lang="ts">
interface Heading {
	id: string;
	text: string;
	level: number;
}

const { t } = useI18n();

// The heading text itself is scraped from the rendered page, so it is already
// in the locale the content was served in — only the chrome needs translating.
const headings = ref<Heading[]>([]);
const activeId = ref('');

function collectHeadings() {
	const els = document.querySelectorAll('.prose h2, .prose h3');
	headings.value = Array.from(els)
		.filter((el) => el.id)
		.map((el) => ({
			id: el.id,
			text: el.textContent?.trim() || '',
			level: parseInt(el.tagName[1]!),
		}));
}

function updateActiveHeading() {
	const offset = 100;
	let current = '';

	for (const heading of headings.value) {
		const el = document.getElementById(heading.id);
		if (!el) continue;
		if (el.getBoundingClientRect().top <= offset) {
			current = heading.id;
		}
	}

	activeId.value = current || headings.value[0]?.id || '';
}

function scrollToHeading(id: string) {
	const el = document.getElementById(id);
	if (el) {
		el.scrollIntoView({ behavior: 'smooth', block: 'start' });
		activeId.value = id;
	}
}

let onScroll: (() => void) | null = null;
let observer: MutationObserver | null = null;

onMounted(() => {
	collectHeadings();

	const main = document.querySelector('main');
	if (main) {
		observer = new MutationObserver(() => {
			collectHeadings();
			updateActiveHeading();
		});
		observer.observe(main, { childList: true, subtree: true });
	}

	updateActiveHeading();
	onScroll = () => updateActiveHeading();
	window.addEventListener('scroll', onScroll, { passive: true });
});

onUnmounted(() => {
	if (onScroll) window.removeEventListener('scroll', onScroll);
	if (observer) observer.disconnect();
});
</script>

<style scoped>
.toc {
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.toc-list {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.toc-link {
	display: block;
	padding: 4px 8px;
	font-size: var(--text-caption);
	line-height: 1.4;
	border-radius: 6px;
	text-decoration: none;
	color: var(--color-text-secondary);
	transition: color var(--motion-fast);
}

.toc-h2 {
	padding-left: 8px;
}

.toc-h3 {
	padding-left: 20px;
}

.toc-link.active {
	color: var(--color-text-primary);
	font-weight: var(--font-weight-semibold, 550);
}

.toc-link:not(.active):hover {
	color: var(--color-text-primary);
}
</style>
