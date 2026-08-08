// @vitest-environment happy-dom
/**
 * The carry-over step: two imports, strictly in order, judged on the RUN'S ID.
 *
 * The backend allows one import at a time, so the only thing that makes this
 * step work is that it waits — and the only thing that makes waiting correct is
 * that it waits for the run it started, not for "an import" to stop running.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref, type Ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';

const stubs = {
	Icon: { template: '<i />' },
	NuxtLink: { template: '<a><slot /></a>' },
	UiInput: {
		props: ['modelValue'],
		emits: ['update:modelValue'],
		template:
			'<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
	},
	UiButton: {
		props: ['disabled', 'variant'],
		// `emits` matters: without it the parent's `onClick` ALSO falls through to
		// the root element and every press registers twice.
		emits: ['click'],
		template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
	},
};

interface Run {
	_id: string;
	status: 'running' | 'completed' | 'failed';
	provider: string;
	imported: number;
	updated: number;
	skipped: number;
	failed: number;
	errors: string[];
	suppressionCounts?: Record<string, number>;
}

function run(over: Partial<Run> = {}): Run {
	return {
		_id: 'imp_1',
		status: 'running',
		provider: 'mailchimp',
		imported: 0,
		updated: 0,
		skipped: 0,
		failed: 0,
		errors: [],
		...over,
	};
}

let progress: Ref<Run | null>;
let mutation: ReturnType<typeof vi.fn>;
let started: { name: string; args: Record<string, unknown> }[];
let flags: Record<string, boolean>;

function mutationName(reference: unknown): string {
	// The stubbed client is handed the real `api.*` reference; its function name
	// is enough to tell the two mutations apart without importing the codegen.
	return getFunctionName(reference as FunctionReference<'mutation'>).includes('cancelImport')
		? 'cancel'
		: 'start';
}

async function mountStep(props: Record<string, unknown> = {}) {
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (flag: string) => flags[flag] === true,
	}));
	vi.stubGlobal('useConvex', () => ({ mutation }));
	vi.stubGlobal('useConvexQuery', () => ({ data: progress }));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	const component = (await import('../MigrationImportStep.vue')).default;
	return mount(component, { props, global: { stubs } });
}

beforeEach(() => {
	progress = ref<Run | null>(null);
	started = [];
	flags = { 'imports.mailchimp': true, 'imports.mandrill': true };
	let nextId = 0;
	mutation = vi.fn(async (reference: unknown, args: Record<string, unknown>) => {
		const name = mutationName(reference);
		started.push({ name, args });
		if (name === 'cancel') return undefined;
		nextId += 1;
		const id = `imp_${nextId}`;
		progress.value = run({
			_id: id,
			provider: String((args.config as { provider: string }).provider),
		});
		return id;
	});
});

afterEach(() => {
	vi.resetModules();
});

/** Fill the Mailchimp credentials and press the run button. */
async function startCarryOver(wrapper: Awaited<ReturnType<typeof mountStep>>): Promise<void> {
	await wrapper.find('[data-testid="migration-mailchimp-key"]').setValue('abc123-us21');
	await wrapper.find('[data-testid="migration-mailchimp-list"]').setValue('list-1');
	await wrapper.find('[data-testid="migration-import-run"]').trigger('click');
	await nextTick();
}

/** Report a terminal status for the given run and let the watcher settle. */
async function finish(id: string, over: Partial<Run> = {}): Promise<void> {
	progress.value = run({ _id: id, status: 'completed', ...over });
	await nextTick();
	await nextTick();
}

describe('the two imports run in order', () => {
	it('starts the audience first, with suppression carry-over switched on', async () => {
		const wrapper = await mountStep();
		await startCarryOver(wrapper);

		expect(started).toHaveLength(1);
		expect(started[0]?.args.config).toEqual({
			provider: 'mailchimp',
			apiKey: 'abc123-us21',
			listId: 'list-1',
			importSuppressions: true,
		});
		expect(started[0]?.args.handleDuplicates).toBe('skip');
	});

	it('does not start the reject list until the audience run finishes', async () => {
		const wrapper = await mountStep();
		await startCarryOver(wrapper);

		// Still running: a second start here would earn `invalid_state`.
		progress.value = run({ _id: 'imp_1', imported: 40 });
		await nextTick();
		expect(started).toHaveLength(1);

		await finish('imp_1', { imported: 120, updated: 3, skipped: 1 });
		expect(started).toHaveLength(2);
		// No credential field: the reject list reads MANDRILL_API_KEY from the env.
		expect(started[1]?.args.config).toEqual({ provider: 'mandrill' });
	});

	it('ignores a terminal status belonging to some other run', async () => {
		const wrapper = await mountStep();
		await startCarryOver(wrapper);

		// `getImportProgress` answers with ONE run — the running one, else the most
		// recent. A completed older run must not be mistaken for ours.
		await finish('imp_older');
		expect(started).toHaveLength(1);
	});

	it('reports the carried counts and calls the step done', async () => {
		const wrapper = await mountStep();
		await startCarryOver(wrapper);
		await finish('imp_1', { imported: 120, updated: 3, skipped: 1 });
		await finish('imp_2', {
			provider: 'mandrill',
			suppressionCounts: {
				bouncedHard: 12,
				bouncedSoft: 0,
				complained: 3,
				manual: 0,
				unsubscribed: 400,
				alreadyBlocked: 0,
				alreadyUnsubscribed: 0,
				noContact: 0,
				skipped: 0,
			},
		});

		expect(wrapper.find('[data-testid="migration-import-contacts"]').text()).toContain(
			'120 imported'
		);
		const carried = wrapper.find('[data-testid="migration-import-carried"]').text();
		expect(carried).toContain('400 unsubscribed');
		expect(carried).toContain('12 hard bounces');
		expect(wrapper.find('[data-testid="migration-import-done"]').exists()).toBe(true);
		expect(wrapper.emitted('carried')?.at(-1)).toEqual([true]);
	});

	it('stops at a failed run and says so, without starting the second', async () => {
		const wrapper = await mountStep();
		await startCarryOver(wrapper);
		await finish('imp_1', { status: 'failed', errors: ['Mailchimp rejected the API key'] });

		expect(started).toHaveLength(1);
		expect(wrapper.find('[data-testid="migration-import-error"]').text()).toContain(
			'Mailchimp rejected the API key'
		);
		expect(wrapper.emitted('carried')?.at(-1)).toEqual([false]);
	});

	it('re-runs with no confirmation — both imports are idempotent', async () => {
		const wrapper = await mountStep();
		await startCarryOver(wrapper);
		await finish('imp_1');
		await finish('imp_2', { provider: 'mandrill' });

		expect(wrapper.find('[data-testid="migration-import-run"]').text()).toContain('again');
		await wrapper.find('[data-testid="migration-import-run"]').trigger('click');
		await nextTick();
		expect(started).toHaveLength(3);
	});
});

describe('what stops the step running', () => {
	it('refuses to start without a plausible Mailchimp key and audience', async () => {
		const wrapper = await mountStep();
		const button = wrapper.find('[data-testid="migration-import-run"]');
		expect(button.attributes('disabled')).toBeDefined();

		await wrapper.find('[data-testid="migration-mailchimp-key"]').setValue('nodatacenter');
		await wrapper.find('[data-testid="migration-mailchimp-list"]').setValue('list-1');
		expect(
			wrapper.find('[data-testid="migration-import-run"]').attributes('disabled')
		).toBeDefined();
	});

	it('stays disabled while an earlier step is outstanding', async () => {
		const wrapper = await mountStep({
			isBlocked: true,
			blockedReason: 'Connect Mailchimp Transactional first.',
		});
		await startCarryOver(wrapper);
		expect(started).toHaveLength(0);
		expect(wrapper.find('[data-testid="migration-import-blocked"]').text()).toContain(
			'Connect Mailchimp Transactional first.'
		);
	});

	it('says where the switch is when both import flags are off', async () => {
		flags = {};
		const wrapper = await mountStep();
		expect(wrapper.find('[data-testid="migration-import-flags-off"]').exists()).toBe(true);
		expect(
			wrapper.find('[data-testid="migration-import-run"]').attributes('disabled')
		).toBeDefined();
	});

	it('goes straight to the reject list when only the Mandrill flag is on', async () => {
		flags = { 'imports.mandrill': true };
		const wrapper = await mountStep();
		await wrapper.find('[data-testid="migration-import-run"]').trigger('click');
		await nextTick();

		expect(started).toHaveLength(1);
		expect(started[0]?.args.config).toEqual({ provider: 'mandrill' });
		await finish('imp_1', { provider: 'mandrill' });
		expect(wrapper.emitted('carried')?.at(-1)).toEqual([true]);
	});
});
