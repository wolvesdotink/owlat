/**
 * Undo-send window state for CAMPAIGNS.
 *
 * A singleton `useState` (mirroring `usePostboxUndoSend`) so the surface that
 * armed the send — the wizard's Review step, the campaign editor — can navigate
 * away immediately and the toast, mounted on the report the send lands on,
 * still knows what is in flight and until when.
 *
 * Only serializable data lives here: the campaign the send was armed for and
 * the instant it fires. The cancel itself is the toast's job, because the
 * arming component is unmounted by the time anyone clicks Undo.
 */

import type { Id } from '@owlat/api/dataModel';

interface CampaignUndoSendState {
	visible: boolean;
	campaignId: Id<'campaigns'> | null;
	/** Shown in the toast, so the countdown says WHICH campaign is going out. */
	campaignName: string;
	/** Epoch ms the held send fires — drives the countdown. */
	sendAt: number;
}

const EMPTY: CampaignUndoSendState = {
	visible: false,
	campaignId: null,
	campaignName: '',
	sendAt: 0,
};

export function useCampaignUndoSend() {
	const state = useState<CampaignUndoSendState>('campaigns:undo-send', () => ({ ...EMPTY }));

	/** Arm the window for a freshly held send; a second arm replaces the first. */
	function arm(args: { campaignId: Id<'campaigns'>; campaignName: string; sendAt: number }) {
		state.value = {
			visible: true,
			campaignId: args.campaignId,
			campaignName: args.campaignName,
			sendAt: args.sendAt,
		};
	}

	function dismiss() {
		state.value = { ...EMPTY };
	}

	return { state, arm, dismiss };
}
