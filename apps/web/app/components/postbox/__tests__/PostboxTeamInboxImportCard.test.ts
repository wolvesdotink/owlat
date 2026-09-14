// @vitest-environment happy-dom
/**
 * TeamInboxImportCard — pulling a team inbox's existing mail in, from the admin
 * roster page.
 *
 * The card is mounted over the REAL `useSharedMailMigration`, with only the
 * Convex boundary faked, so a rename or a rewiring there fails here too.
 *
 * What it must not get wrong:
 *  - the opt-in. Learning from a team's whole archive is an org-wide privacy and
 *    cost decision, so the checkbox exists only where the knowledge graph does,
 *    and an unchecked box must reach the backend as an explicit `false`;
 *  - the running count. An import takes hours, and "X of Y imported" is the only
 *    thing that tells an admin it is alive rather than wedged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, defineComponent, h, type Ref } from 'vue';
import { getFunctionName, type FunctionReturnType } from 'convex/server';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

import TeamInboxImportCard from '../TeamInboxImportCard.vue';
import { useSharedMailMigration } from '~/composables/postbox/useMailMigration';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

type Status = FunctionReturnType<typeof api.mail.migrationShared.getStatusShared>;
type Account = FunctionReturnType<typeof api.mail.external.sharedInbox.getSharedExternalAccount>;

const MAILBOX_ID = 'mailbox_support' as Id<'mailboxes'>;

const status: Ref<Status> = ref(null);
const account: Ref<Account> = ref({ configured: false });
const knowledgeFlag = ref(false);
/** Neither subscription has delivered a first value yet. */
const queryLoading = ref(false);
const runs: { name: string; args: unknown }[] = [];

function migrationRow(overrides: Partial<NonNullable<Status>>): Status {
	return {
		_id: 'migration_1',
		status: 'importing',
		source: 'google',
		isAiIndexingEnabled: false,
		messagesTotal: 8300,
		messagesImported: 1204,
		messagesIndexed: 0,
		importPercent: 14,
		indexPercent: 0,
		startedAt: 1,
		...overrides,
	} as Status;
}

beforeEach(() => {
	status.value = null;
	account.value = {
		configured: true,
		mailboxId: MAILBOX_ID,
		emailAddress: 'support@owlat.test',
		imapHost: 'imap.gmail.com',
		status: 'connected',
	} as unknown as Account;
	knowledgeFlag.value = false;
	queryLoading.value = false;
	runs.length = 0;

	vi.stubGlobal('useSharedMailMigration', useSharedMailMigration);
	vi.stubGlobal('useConvexQuery', (reference: Parameters<typeof getFunctionName>[0]) => ({
		data:
			getFunctionName(reference) === getFunctionName(api.mail.migrationShared.getStatusShared)
				? status
				: account,
		isLoading: queryLoading,
		error: ref(null),
	}));
	vi.stubGlobal('useBackendOperation', (reference: Parameters<typeof getFunctionName>[0]) => ({
		run: async (args: unknown) => {
			runs.push({ name: getFunctionName(reference), args });
			return { ok: true, result: { migrationId: 'migration_1', status: 'importing' } };
		},
		isLoading: ref(false),
		inlineError: ref(null),
	}));
	vi.stubGlobal('useToast', () => ({ showToast: () => {} }));
	vi.stubGlobal('useFeatureFlag', () => ({
		isEnabled: (flag: string) => flag === 'ai.knowledge' && knowledgeFlag.value,
	}));
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const checkboxStub = defineComponent({
	props: { modelValue: { type: Boolean, default: false }, label: { type: String, default: '' } },
	emits: ['update:modelValue'],
	setup:
		(props, { emit }) =>
		() =>
			h('label', [
				h('input', {
					type: 'checkbox',
					checked: props.modelValue,
					onChange: (event: Event) =>
						emit('update:modelValue', (event.target as HTMLInputElement).checked),
				}),
				props.label,
			]),
});
const progressStub = defineComponent({
	props: { value: { type: Number, default: 0 }, indeterminate: Boolean },
	setup: (props) => () => h('div', { 'data-progress': props.indeterminate ? 'idk' : props.value }),
});
const dialogStub = defineComponent({
	props: { open: Boolean, title: { type: String, default: '' } },
	setup: (props) => () => (props.open ? h('div', { 'data-testid': 'cancel-dialog' }) : null),
});

const mountCard = () =>
	mount(TeamInboxImportCard, {
		props: { mailboxId: MAILBOX_ID, address: 'support@owlat.test' },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiCheckbox: checkboxStub,
				UiProgressBar: progressStub,
				UiConfirmationDialog: dialogStub,
			},
		},
	});

describe('TeamInboxImportCard', () => {
	it('offers the import, with learning off unless the instance has it', async () => {
		const wrapper = mountCard();

		expect(wrapper.find('[data-testid="team-inbox-import-knowledge"]').exists()).toBe(false);
		expect(wrapper.text()).toContain('Import existing mail');
		expectFullyLocalized(wrapper);

		await wrapper.find('[data-testid="team-inbox-import-start"]').trigger('click');
		await flushPromises();

		expect(runs).toEqual([
			{
				name: 'mail/migrationShared:startShared',
				args: { mailboxId: MAILBOX_ID, source: 'google', indexKnowledge: false },
			},
		]);
	});

	it('opts into learning only when the box is ticked', async () => {
		knowledgeFlag.value = true;
		const wrapper = mountCard();

		const checkbox = wrapper.find('[data-testid="team-inbox-import-knowledge"]');
		expect(checkbox.exists()).toBe(true);
		await checkbox.find('input').setValue(true);
		await wrapper.find('[data-testid="team-inbox-import-start"]').trigger('click');
		await flushPromises();

		expect(runs[0]!.args).toMatchObject({ indexKnowledge: true });
	});

	it('counts the import while it runs, and offers a way out of it', async () => {
		status.value = migrationRow({});
		const wrapper = mountCard();

		const running = wrapper.find('[data-testid="team-inbox-import-running"]');
		expect(running.exists()).toBe(true);
		expect(running.text()).toContain('1,204 of 8,300 messages imported');
		expect(running.text()).toContain('14%');
		expect(wrapper.find('[data-testid="team-inbox-import-start"]').exists()).toBe(false);
		expectFullyLocalized(wrapper);

		// The stop is a confirmation, not a one-click undo of hours of work.
		expect(wrapper.find('[data-testid="cancel-dialog"]').exists()).toBe(false);
		await running.find('button').trigger('click');
		expect(wrapper.find('[data-testid="cancel-dialog"]').exists()).toBe(true);
		expect(runs).toEqual([]);
	});

	it('says nothing is counted yet rather than showing a stuck zero', () => {
		status.value = migrationRow({ messagesTotal: 0, messagesImported: 0, importPercent: 0 });
		const wrapper = mountCard();

		expect(wrapper.text()).toContain('Counting folders…');
		expect(wrapper.text()).not.toContain('0 of 0');
	});

	it('waits for the subscriptions instead of flashing a Start button', async () => {
		// An inbox halfway through an import looks exactly like an idle one until
		// the status query reports: same `step`, same derivation default. Showing
		// the idle branch there would offer "Import existing mail" to an admin
		// whose import is already running.
		queryLoading.value = true;
		status.value = migrationRow({});
		const wrapper = mountCard();

		expect(wrapper.find('[data-testid="team-inbox-import-loading"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="team-inbox-import-start"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="team-inbox-import-running"]').exists()).toBe(false);

		queryLoading.value = false;
		await flushPromises();
		expect(wrapper.find('[data-testid="team-inbox-import-loading"]').exists()).toBe(false);
		expect(wrapper.find('[data-testid="team-inbox-import-running"]').exists()).toBe(true);
	});

	it('reports what landed when the import is done', () => {
		status.value = migrationRow({
			status: 'completed',
			messagesImported: 8300,
			importPercent: 100,
			importCompletedAt: 2,
			completedAt: 3,
		});
		const wrapper = mountCard();

		const done = wrapper.find('[data-testid="team-inbox-import-completed"]');
		expect(done.exists()).toBe(true);
		expect(done.text()).toContain('8,300 messages are now in this inbox');
		expectFullyLocalized(wrapper);
	});

	it('lets a finished import be run again — the backend allows a second one', async () => {
		status.value = migrationRow({
			status: 'completed',
			messagesImported: 8300,
			importPercent: 100,
			completedAt: 3,
		});
		const wrapper = mountCard();

		await wrapper.find('[data-testid="team-inbox-import-again"]').trigger('click');
		await flushPromises();

		expect(runs).toEqual([
			{
				name: 'mail/migrationShared:startShared',
				args: { mailboxId: MAILBOX_ID, source: 'google', indexKnowledge: false },
			},
		]);
	});

	it('shows a failure with its reason, truncated, and a way to retry', async () => {
		status.value = migrationRow({
			status: 'failed',
			lastError: 'x'.repeat(400),
			messagesImported: 40,
		});
		const wrapper = mountCard();

		const failed = wrapper.find('[data-testid="team-inbox-import-failed"]');
		expect(failed.text()).toContain('x'.repeat(200) + '…');
		expect(failed.text()).not.toContain('x'.repeat(201));
		expect(failed.text()).toContain('The 40 messages imported so far were kept.');

		await wrapper.find('[data-testid="team-inbox-import-retry"]').trigger('click');
		await flushPromises();
		expect(runs[0]!.name).toBe('mail/migrationShared:startShared');
	});
});
