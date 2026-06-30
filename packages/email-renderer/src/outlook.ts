/**
 * Wraps content in Outlook conditional comments.
 */
export const msoConditional = (html: string): string => {
	return `<!--[if mso]>${html}<![endif]-->`;
};

/**
 * Wraps content in NOT-mso conditional comments (for non-Outlook clients).
 */
export const notMsoConditional = (html: string): string => {
	return `<!--[if !mso]><!-->${html}<!--<![endif]-->`;
};

/**
 * Office document settings XML for Outlook.
 */
export const getOfficeDocumentSettings = (): string => {
	return `<!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->`;
};

/**
 * Outlook fixed-width table wrapper (opening).
 */
export const msoTableOpen = (width: number): string => {
	return `<!--[if mso]><table width="${width}" cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td><![endif]-->`;
};

/**
 * Outlook fixed-width table wrapper (closing).
 */
export const msoTableClose = (): string => {
	return `<!--[if mso]></td></tr></table><![endif]-->`;
};

/**
 * Outlook column table wrappers for multi-column layouts.
 */
export const msoColumnsOpen = (totalWidth: number, direction?: 'ltr' | 'rtl'): string => {
	const dir = direction === 'rtl' ? ' dir="rtl"' : '';
	return `<!--[if mso]><table width="${totalWidth}" cellpadding="0" cellspacing="0" border="0" role="presentation"${dir}><tr><![endif]-->`;
};

export const msoColumnCellOpen = (widthPx: number, valign: string = 'top'): string => {
	return `<!--[if mso]><td width="${widthPx}" valign="${valign}"><![endif]-->`;
};

export const msoColumnCellClose = (): string => {
	return `<!--[if mso]></td><![endif]-->`;
};

export const msoColumnsClose = (): string => {
	return `<!--[if mso]></tr></table><![endif]-->`;
};

/**
 * VML background image for Outlook (used in hero/container blocks).
 * Requires v: and o: XML namespaces on the <html> element.
 */
export const msoVmlBackground = (
	imageUrl: string,
	width: number,
	height: number,
	bgColor: string = '#ffffff',
): string => {
	return `<!--[if gte mso 9]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:${width}px;height:${height}px"><v:fill type="frame" src="${imageUrl}" color="${bgColor}" /><v:textbox inset="0,0,0,0" style="mso-fit-shape-to-text:true"><![endif]-->`;
};

export const msoVmlBackgroundClose = (): string => {
	return `<!--[if gte mso 9]></v:textbox></v:rect><![endif]-->`;
};
