package com.owlat.sdk.model.template;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/** What the health scores read from the rendered HTML. */
public class EmailHtmlAnalysis {

    private final int htmlSizeBytes;
    private final boolean exceedsGmailClip;
    private final boolean exceedsGmailCssLimit;
    private final int styleBlockSizeBytes;
    private final int tableNestingDepth;
    private final int imageCount;
    private final int linkCount;
    private final boolean hasTextContent;
    private final Double textToImageRatio;
    private final int displayNoneCount;
    private final List<String> warnings;

    @JsonCreator
    public EmailHtmlAnalysis(
            @JsonProperty("htmlSizeBytes") int htmlSizeBytes,
            @JsonProperty("exceedsGmailClip") boolean exceedsGmailClip,
            @JsonProperty("exceedsGmailCssLimit") boolean exceedsGmailCssLimit,
            @JsonProperty("styleBlockSizeBytes") int styleBlockSizeBytes,
            @JsonProperty("tableNestingDepth") int tableNestingDepth,
            @JsonProperty("imageCount") int imageCount,
            @JsonProperty("linkCount") int linkCount,
            @JsonProperty("hasTextContent") boolean hasTextContent,
            @JsonProperty("textToImageRatio") Double textToImageRatio,
            @JsonProperty("displayNoneCount") int displayNoneCount,
            @JsonProperty("warnings") List<String> warnings) {
        this.htmlSizeBytes = htmlSizeBytes;
        this.exceedsGmailClip = exceedsGmailClip;
        this.exceedsGmailCssLimit = exceedsGmailCssLimit;
        this.styleBlockSizeBytes = styleBlockSizeBytes;
        this.tableNestingDepth = tableNestingDepth;
        this.imageCount = imageCount;
        this.linkCount = linkCount;
        this.hasTextContent = hasTextContent;
        this.textToImageRatio = textToImageRatio;
        this.displayNoneCount = displayNoneCount;
        this.warnings = warnings;
    }

    public int getHtmlSizeBytes() {
        return htmlSizeBytes;
    }

    /** Over the size after which Gmail hides the rest of the body. */
    public boolean isExceedsGmailClip() {
        return exceedsGmailClip;
    }

    /** Over the style size past which Gmail drops the styles. */
    public boolean isExceedsGmailCssLimit() {
        return exceedsGmailCssLimit;
    }

    public int getStyleBlockSizeBytes() {
        return styleBlockSizeBytes;
    }

    public int getTableNestingDepth() {
        return tableNestingDepth;
    }

    public int getImageCount() {
        return imageCount;
    }

    public int getLinkCount() {
        return linkCount;
    }

    public boolean isHasTextContent() {
        return hasTextContent;
    }

    /** Characters of text per image; {@code null} when there is text and no image. */
    public Double getTextToImageRatio() {
        return textToImageRatio;
    }

    /** Hidden elements beyond the preheader. */
    public int getDisplayNoneCount() {
        return displayNoneCount;
    }

    public List<String> getWarnings() {
        return warnings;
    }
}
