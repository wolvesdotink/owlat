/** What the pre-send checks are run on. */
import type { EditorBlock, EmailTheme } from '@owlat/shared';
import type { LinkPlan } from './links';
import type { PresendRemote } from './remote';
import type { ScannedHtml } from './scanHtml';

export interface PresendInput {
	blocks: EditorBlock[];
	subject: string;
	theme: Required<EmailTheme>;
	/** Known on the Review step; the editor does not know where the email goes. */
	audienceKind?: 'topic' | 'segment';
	/** Review step only: why the send is refused today, `null` when it is not. */
	blockedReason?: string | null;
	remote: PresendRemote;
}

/** What the server round trip should be asked, derived from the same scan. */
export interface PresendScan {
	html: ScannedHtml;
	links: LinkPlan;
	images: string[];
}
