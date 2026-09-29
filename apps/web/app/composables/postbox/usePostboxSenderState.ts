import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { MaybeRefOrGetter } from 'vue';

/**
 * One sender's VIP flag and first-time-sender screener state in a mailbox,
 * plus the two corrections the reader offers on it: the VIP toggle and
 * "Accept sender". Shared by the trust chip's sender controls and the sender
 * profile panel, so both show the same answer.
 *
 * The screener decision is the server's (`mail/contacts.senderState`, built on
 * the Reply Queue gate's own rule): `canAccept` means the gate is holding this
 * sender back today, so Accept would release their mail. Nothing here restates
 * that rule. `isAccepted` is the other side of the same answer: the screener
 * applies to this mailbox and lets the sender through (known, VIP or accepted).
 *
 * `enabled` lets a closed panel skip the subscription; an address without an
 * `@` skips it too. While skipped or loading, every flag reads false.
 */
export function usePostboxSenderState(opts: {
	mailboxId: MaybeRefOrGetter<string>;
	/** The bare address (`extractEmailAddress` of the From line). */
	email: MaybeRefOrGetter<string>;
	enabled?: MaybeRefOrGetter<boolean>;
}) {
	const { t } = useI18n();

	const args = computed(() => {
		const email = toValue(opts.email);
		if (toValue(opts.enabled ?? true) === false || !email.includes('@')) return null;
		return { mailboxId: toValue(opts.mailboxId) as Id<'mailboxes'>, email };
	});

	const { data } = useConvexQuery(
		api.mail.contacts.senderState,
		() => args.value ?? ('skip' as const)
	);

	const isVip = computed(() => data.value?.isVip === true);
	const canAccept = computed(() => data.value?.canAccept === true);
	const isAccepted = computed(
		() => data.value?.isScreenerEnabled === true && data.value?.canAccept !== true
	);

	const setVipOp = useBackendOperation(api.mail.contacts.setVip, {
		label: () => t('components.postbox.postboxSenderControls.vipOperation'),
	});
	const acceptOp = useBackendOperation(api.mail.contacts.acceptSender, {
		label: () => t('components.postbox.postboxSenderControls.acceptOperation'),
	});

	const busy = computed(() => setVipOp.isLoading.value || acceptOp.isLoading.value);

	function toggleVip(): void {
		if (!args.value) return;
		void setVipOp.run({ ...args.value, isVip: !isVip.value });
	}

	function acceptSender(): void {
		if (!args.value) return;
		void acceptOp.run(args.value);
	}

	return { isVip, canAccept, isAccepted, toggleVip, acceptSender, busy };
}
