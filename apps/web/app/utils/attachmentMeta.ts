/**
 * One attachment row, as both readers describe one.
 *
 * THE one attachment row type, for both readers: the Postbox reader, the team
 * inbox, their shared list component, the download composable and the `utils/`
 * parser all name this, so `partIndex` semantics change in one declaration.
 *
 * A PLAIN MODULE owns it rather than the component that renders it — a utility
 * module depending on a component for a data shape is unusable anywhere that
 * component is not.
 *
 * The bytes are NOT here. Both readers store metadata on the message row and
 * keep the content in the sealed raw MIME, so a download means fetching the
 * raw `.eml` and extracting `partIndex` out of it — see `useMimePartDownload`.
 */
export type AttachmentMeta = {
	filename: string;
	contentType: string;
	size: number;
	/**
	 * The MIME walk position `extractAttachmentAt` addresses this part by.
	 * Absent on mail received before the MTA sent it, which falls back to
	 * matching on the filename.
	 */
	partIndex?: string;
};
