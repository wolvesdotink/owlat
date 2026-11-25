package com.owlat.sdk.model.brandkit;

import java.util.List;

/**
 * The brand kit fields to change. A field left unset is not sent and keeps its
 * stored value. The logos cannot be changed through the API.
 */
public class BrandKitInput {

    private final String primaryColor;
    private final String secondaryColor;
    private final String textColor;
    private final String backgroundColor;
    private final String linkColor;
    private final List<String> swatches;
    private final String headingFontFamily;
    private final String bodyFontFamily;
    private final Double buttonRadius;
    private final Double buttonPaddingX;
    private final Double buttonPaddingY;
    private final Double baseWidth;
    private final String footerCompanyName;
    private final String footerAddress;
    private final List<BrandKitSocialLink> footerSocialLinks;

    private BrandKitInput(Builder builder) {
        this.primaryColor = builder.primaryColor;
        this.secondaryColor = builder.secondaryColor;
        this.textColor = builder.textColor;
        this.backgroundColor = builder.backgroundColor;
        this.linkColor = builder.linkColor;
        this.swatches = builder.swatches;
        this.headingFontFamily = builder.headingFontFamily;
        this.bodyFontFamily = builder.bodyFontFamily;
        this.buttonRadius = builder.buttonRadius;
        this.buttonPaddingX = builder.buttonPaddingX;
        this.buttonPaddingY = builder.buttonPaddingY;
        this.baseWidth = builder.baseWidth;
        this.footerCompanyName = builder.footerCompanyName;
        this.footerAddress = builder.footerAddress;
        this.footerSocialLinks = builder.footerSocialLinks;
    }

    public String getPrimaryColor() {
        return primaryColor;
    }

    public String getSecondaryColor() {
        return secondaryColor;
    }

    public String getTextColor() {
        return textColor;
    }

    public String getBackgroundColor() {
        return backgroundColor;
    }

    public String getLinkColor() {
        return linkColor;
    }

    public List<String> getSwatches() {
        return swatches;
    }

    public String getHeadingFontFamily() {
        return headingFontFamily;
    }

    public String getBodyFontFamily() {
        return bodyFontFamily;
    }

    public Double getButtonRadius() {
        return buttonRadius;
    }

    public Double getButtonPaddingX() {
        return buttonPaddingX;
    }

    public Double getButtonPaddingY() {
        return buttonPaddingY;
    }

    public Double getBaseWidth() {
        return baseWidth;
    }

    public String getFooterCompanyName() {
        return footerCompanyName;
    }

    public String getFooterAddress() {
        return footerAddress;
    }

    public List<BrandKitSocialLink> getFooterSocialLinks() {
        return footerSocialLinks;
    }

    public static Builder builder() {
        return new Builder();
    }

    public static class Builder {
        private String primaryColor;
        private String secondaryColor;
        private String textColor;
        private String backgroundColor;
        private String linkColor;
        private List<String> swatches;
        private String headingFontFamily;
        private String bodyFontFamily;
        private Double buttonRadius;
        private Double buttonPaddingX;
        private Double buttonPaddingY;
        private Double baseWidth;
        private String footerCompanyName;
        private String footerAddress;
        private List<BrandKitSocialLink> footerSocialLinks;

        /** Hex colour of buttons and accents: {@code #rgb} or {@code #rrggbb}. */
        public Builder primaryColor(String primaryColor) {
            this.primaryColor = primaryColor;
            return this;
        }

        /** Hex colour of dividers. */
        public Builder secondaryColor(String secondaryColor) {
            this.secondaryColor = secondaryColor;
            return this;
        }

        /** Hex colour of body text. */
        public Builder textColor(String textColor) {
            this.textColor = textColor;
            return this;
        }

        /** Hex colour of the email background. */
        public Builder backgroundColor(String backgroundColor) {
            this.backgroundColor = backgroundColor;
            return this;
        }

        /** Hex colour of links. */
        public Builder linkColor(String linkColor) {
            this.linkColor = linkColor;
            return this;
        }

        /** Up to six more hex colours for the colour pickers. */
        public Builder swatches(List<String> swatches) {
            this.swatches = swatches;
            return this;
        }

        /** The font of headings: one of the CSS font stacks the brand kit offers, spelled exactly. */
        public Builder headingFontFamily(String headingFontFamily) {
            this.headingFontFamily = headingFontFamily;
            return this;
        }

        /** The font of body text: one of the CSS font stacks the brand kit offers, spelled exactly. */
        public Builder bodyFontFamily(String bodyFontFamily) {
            this.bodyFontFamily = bodyFontFamily;
            return this;
        }

        /** Button corner radius in pixels. */
        public Builder buttonRadius(double buttonRadius) {
            this.buttonRadius = buttonRadius;
            return this;
        }

        /** Button padding left and right, in pixels. */
        public Builder buttonPaddingX(double buttonPaddingX) {
            this.buttonPaddingX = buttonPaddingX;
            return this;
        }

        /** Button padding top and bottom, in pixels. */
        public Builder buttonPaddingY(double buttonPaddingY) {
            this.buttonPaddingY = buttonPaddingY;
            return this;
        }

        /** Email content width in pixels. */
        public Builder baseWidth(double baseWidth) {
            this.baseWidth = baseWidth;
            return this;
        }

        /** The company name above the postal address in the footer. */
        public Builder footerCompanyName(String footerCompanyName) {
            this.footerCompanyName = footerCompanyName;
            return this;
        }

        /** The postal address in the footer, one line per line. */
        public Builder footerAddress(String footerAddress) {
            this.footerAddress = footerAddress;
            return this;
        }

        /** The social links in the footer. */
        public Builder footerSocialLinks(List<BrandKitSocialLink> footerSocialLinks) {
            this.footerSocialLinks = footerSocialLinks;
            return this;
        }

        public BrandKitInput build() {
            return new BrandKitInput(this);
        }
    }
}
