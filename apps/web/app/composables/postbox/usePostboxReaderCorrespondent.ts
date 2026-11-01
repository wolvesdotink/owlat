/**
 * The open conversation's correspondent (Sealed Mail 1:1 plane) and their
 * PUBLIC sealing-key status, read once per thread (E5).
 */
import { computed, type Ref } from 'vue';
import { extractEmailAddress } from '~/utils/emailAddress';

export function usePostboxReaderCorrespondent(source: {
	messages: Ref<Array<{ fromAddress: string; toAddresses: string[] }>>;
	ownAddresses: Ref<Set<string>>;
	/** The `sealedMail` flag: off, no key status is read. */
	sealedMailEnabled: Ref<boolean>;
}) {
	// The thread's correspondent: the first party in the conversation who isn't
	// us. Prefer an inbound sender; fall back to a recipient on an all-outbound
	// thread. Drives the thread-level key-change banner + contact key panel.
	// Empty when we can't identify a single counterpart (the container then
	// renders nothing).
	const threadCounterpart = computed(() => {
		const own = source.ownAddresses.value;
		for (const m of source.messages.value) {
			const from = extractEmailAddress(m.fromAddress).toLowerCase();
			if (from && !own.has(from)) return from;
		}
		for (const m of source.messages.value) {
			for (const to of m.toAddresses) {
				const addr = extractEmailAddress(to).toLowerCase();
				if (addr && !own.has(addr)) return addr;
			}
		}
		return '';
	});

	// The key-change BANNER stays in the reader — it is an alarm — while the key
	// panel travels into that sender's trust chip popover, and `keyChanged` turns
	// the same chip amber so the rotation is never only one popover deep.
	const {
		status: correspondentKey,
		wasVerified: correspondentKeyWasVerified,
		keyChanged: correspondentKeyChanged,
		refetch: refetchCorrespondentKey,
	} = usePostboxCorrespondentKey(() =>
		source.sealedMailEnabled.value ? threadCounterpart.value : ''
	);

	/** The seal status belongs to the ONE sender it describes, not to every message. */
	function sealStatusFor(msg: { fromAddress: string }) {
		const from = extractEmailAddress(msg.fromAddress).toLowerCase();
		return from && from === threadCounterpart.value ? correspondentKey.value : null;
	}

	return {
		threadCounterpart,
		correspondentKey,
		correspondentKeyWasVerified,
		correspondentKeyChanged,
		refetchCorrespondentKey,
		sealStatusFor,
	};
}
