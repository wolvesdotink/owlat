/**
 * One attachment row, as both readers describe one.
 *
 * A PLAIN MODULE owns it rather than the component that renders it: the type
 * travelled from a `.vue` file into two composables and a `utils/` parser, and
 * a utility module depending on a component for a data shape is the wrong
 * direction — it makes the parser unusable anywhere the component is not.
 * There were five names for it (`MessageAttachmentMeta`, `InboxAttachmentMeta`,
 * `PostboxAttachmentMeta`, `ReaderAttachmentMeta`, `MimePartRef`); this is the
 * one, and `partIndex` semantics now change in a single declaration.
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
