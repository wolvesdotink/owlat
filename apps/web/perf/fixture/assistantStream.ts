/**
 * Family `assistant-stream`: a conversation of real `AssistantMessage` rows
 * with the last answer streaming in.
 *
 * Delivery is modelled on the app's path, not on a hand-tuned shortcut. Each
 * flush the backend writes the whole answer so far (one write per 250 ms,
 * `FLUSH_INTERVAL_MS`), Convex pushes the whole message list as freshly parsed
 * JSON, and `useConvexQuery` runs it through the real `shareStructure` into a
 * `shallowRef`. The host mirrors the assistant page's scroll container and its
 * follow-the-stream wiring (`useFollowLatest` and the same watch source).
 */
import { computed, defineComponent, h, nextTick, onMounted, ref, shallowRef, watch } from 'vue';
import { useFollowLatest } from '~/composables/useFollowLatest';
import { shareStructure } from '~/lib/structuralSharing';
import type { AssistantStreamScenario } from '../scenarios';
import { counter, percentile, timing, type Sample } from '../stats';
import { assistantStreamWorkload, WRITER_LIMITS, type SyntheticAssistantRow } from '../workload';
import { component } from './components';
import { nextFrame, sleepUntil, sum, type Probe } from './probe';

export function assistantStream(scenario: AssistantStreamScenario) {
	const workload = assistantStreamWorkload(scenario);
	const lastAt = workload.history.at(-1)?.createdAt ?? 0;
	const streamingRow = (text: string): SyntheticAssistantRow => ({
		_id: 'perf-msg-streaming',
		role: 'assistant',
		text,
		status: 'streaming',
		toolCalls: [],
		errorMessage: null,
		budgetRefusal: null,
		model: null,
		createdAt: lastAt + 1000,
	});
	const wire = (text: string) => JSON.stringify([...workload.history, streamingRow(text)]);

	const data = shallowRef<SyntheticAssistantRow[] | undefined>(undefined);
	const deliver = (payload: string) => {
		data.value = shareStructure(data.value, JSON.parse(payload) as SyntheticAssistantRow[]);
	};
	deliver(wire(workload.initial));

	const AssistantMessage = component('AssistantMessage');
	const Host = defineComponent({
		name: 'AssistantStreamHost',
		setup() {
			const messages = computed(() => data.value ?? []);
			const scrollRef = ref<HTMLElement | null>(null);
			const { onScroll, onContent, jumpToLatest } = useFollowLatest(scrollRef);
			// The assistant page's watch source (pages/dashboard/assistant/index.vue).
			watch(() => {
				const last = messages.value.at(-1);
				return [
					messages.value.length,
					last?.text.length,
					last?.status,
					last?.toolCalls.length,
					last?.toolCalls.map((c) => c.status).join(),
				];
			}, onContent);
			onMounted(() => void jumpToLatest({ smooth: false }));
			return () =>
				h(
					'div',
					{ ref: scrollRef, class: 'flex-1 overflow-y-auto px-4 py-4', onScrollPassive: onScroll },
					[
						h(
							'div',
							{ class: 'max-w-3xl mx-auto space-y-5' },
							messages.value.map((m) => h(AssistantMessage, { key: m._id, message: m }))
						),
					]
				);
		},
	});

	async function run(probe: Probe): Promise<Sample> {
		probe.takeUpdates();
		probe.takeMutations();
		probe.takeLongTasks();
		const patchMs: number[] = [];
		const deliveryMs: number[] = [];
		const toFrameMs: number[] = [];
		const rowsPerFlush: number[] = [];
		const updatesByName = new Map<string, number>();
		const mutations = { nodesAdded: 0, nodesRemoved: 0, textChanges: 0, attributeChanges: 0 };

		const start = performance.now();
		for (const [i, text] of workload.frames.entries()) {
			await sleepUntil(start + (i + 1) * WRITER_LIMITS.assistantFlushIntervalMs);
			const payload = wire(text);
			const t0 = performance.now();
			deliver(payload);
			const t1 = performance.now();
			await nextTick();
			const t2 = performance.now();
			await nextFrame();
			const t3 = performance.now();
			deliveryMs.push(t1 - t0);
			patchMs.push(t2 - t1);
			toFrameMs.push(t3 - t0);

			const updates = probe.takeUpdates();
			rowsPerFlush.push(updates.get('AssistantMessage') ?? 0);
			for (const [name, n] of updates) updatesByName.set(name, (updatesByName.get(name) ?? 0) + n);
			const tally = probe.takeMutations();
			mutations.nodesAdded += tally.nodesAdded;
			mutations.nodesRemoved += tally.nodesRemoved;
			mutations.textChanges += tally.textChanges;
			mutations.attributeChanges += tally.attributeChanges;
		}
		const longTasks = probe.takeLongTasks();
		const flushes = workload.frames.length;

		const sample: Sample = {
			flushes: counter(flushes),
			'answer length at end': counter(workload.frames.at(-1)?.length ?? 0, 'chars'),
			'rows re-rendered per flush (max)': counter(Math.max(...rowsPerFlush)),
			'component updates': counter(sum(updatesByName.values())),
			'component updates per flush (mean)': counter(sum(updatesByName.values()) / flushes),
		};
		for (const [name, n] of [...updatesByName].sort(([a], [b]) => a.localeCompare(b))) {
			sample[`updates: ${name}`] = counter(n);
		}
		Object.assign(sample, {
			'DOM nodes added': counter(mutations.nodesAdded),
			'DOM nodes removed': counter(mutations.nodesRemoved),
			'DOM text changes': counter(mutations.textChanges),
			'DOM attribute changes': counter(mutations.attributeChanges),
			'delivery (parse + share) p50': timing(percentile(deliveryMs, 0.5)),
			'delivery (parse + share) p95': timing(percentile(deliveryMs, 0.95)),
			'patch p50': timing(percentile(patchMs, 0.5)),
			'patch p95': timing(percentile(patchMs, 0.95)),
			'patch max': timing(Math.max(...patchMs)),
			'flush to next frame p95': timing(percentile(toFrameMs, 0.95)),
			'long tasks': timing(longTasks.length, 'count'),
			'long task time': timing(sum(longTasks)),
		});
		return sample;
	}

	return { Host, rows: workload.history.length + 1, run };
}
