/**
 * Undo-send window state for CAMPAIGNS.
 *
 * An undo window (useUndoWindow) so the surface that armed the send — the
 * wizard's Review step, the campaign editor — can navigate away immediately and
 * the toast, mounted on the report the send lands on, still knows what is in
 * flight and until when.
 *
 * Only serializable data lives here: the campaign the send was armed for and
 * the instant it fires. The cancel itself is the toast's job, because the
 * arming component is unmounted by the time anyone clicks Undo.
 */

import type { Id } from '@owlat/api/dataModel';
import { useUndoWindow } from '~/composables/useUndoWindow';

interface CampaignUndoSendWindow {
	campaignId: Id<'campaigns'> | null;
	/** Shown in the toast, so the countdown says WHICH campaign is going out. */
	campaignName: string;
}

export function useCampaignUndoSend() {
	const {
		state,
		arm: armWindow,
		dismiss,
	} = useUndoWindow<CampaignUndoSendWindow>('campaigns:undo-send', () => ({
		campaignId: null,
		campaignName: '',
	}));

	/** Arm the window for a freshly held send; a second arm replaces the first. */
	function arm(args: { campaignId: Id<'campaigns'>; campaignName: string; sendAt: number }) {
		armWindow({
			campaignId: args.campaignId,
			campaignName: args.campaignName,
			sendAt: args.sendAt,
		});
	}

	return { state, arm, dismiss };
}
