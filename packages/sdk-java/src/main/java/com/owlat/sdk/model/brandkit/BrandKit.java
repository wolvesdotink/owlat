package com.owlat.sdk.model.brandkit;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/**
 * The brand kit: the colours, fonts, button style, logo and footer every email
 * starts from. Until it is saved once, {@link #isConfigured()} is false and
 * every other field holds its default.
 */
public class BrandKit {

    private final boolean configured;
    private final String primaryColor;
    private final String secondaryColor;
    private final String textColor;
    private final String backgroundColor;
    private final String linkColor;
    private final List<String> swatches;
    private final String headingFontFamily;
    private final String bodyFontFamily;
    private final double buttonRadius;
    private final double buttonPaddingX;
    private final double buttonPaddingY;
    private final double baseWidth;
    private final String footerCompanyName;
    private final String footerAddress;
    private final List<BrandKitSocialLink> footerSocialLinks;
    private final BrandKitLogo logo;
    private final BrandKitLogo logoDark;

    @JsonCreator
    public BrandKit(
            @JsonProperty("isConfigured") boolean configured,
            @JsonProperty("primaryColor") String primaryColor,
            @JsonProperty("secondaryColor") String secondaryColor,
            @JsonProperty("textColor") String textColor,
            @JsonProperty("backgroundColor") String backgroundColor,
            @JsonProperty("linkColor") String linkColor,
            @JsonProperty("swatches") List<String> swatches,
            @JsonProperty("headingFontFamily") String headingFontFamily,
            @JsonProperty("bodyFontFamily") String bodyFontFamily,
            @JsonProperty("buttonRadius") double buttonRadius,
            @JsonProperty("buttonPaddingX") double buttonPaddingX,
            @JsonProperty("buttonPaddingY") double buttonPaddingY,
            @JsonProperty("baseWidth") double baseWidth,
            @JsonProperty("footerCompanyName") String footerCompanyName,
            @JsonProperty("footerAddress") String footerAddress,
            @JsonProperty("footerSocialLinks") List<BrandKitSocialLink> footerSocialLinks,
            @JsonProperty("logo") BrandKitLogo logo,
            @JsonProperty("logoDark") BrandKitLogo logoDark) {
        this.configured = configured;
        this.primaryColor = primaryColor;
        this.secondaryColor = secondaryColor;
        this.textColor = textColor;
        this.backgroundColor = backgroundColor;
        this.linkColor = linkColor;
        this.swatches = swatches;
        this.headingFontFamily = headingFontFamily;
        this.bodyFontFamily = bodyFontFamily;
        this.buttonRadius = buttonRadius;
        this.buttonPaddingX = buttonPaddingX;
        this.buttonPaddingY = buttonPaddingY;
        this.baseWidth = baseWidth;
        this.footerCompanyName = footerCompanyName;
        this.footerAddress = footerAddress;
        this.footerSocialLinks = footerSocialLinks;
        this.logo = logo;
        this.logoDark = logoDark;
    }

    /** False until the kit is saved once, in the dashboard or through the API. */
    @JsonProperty("isConfigured")
    public boolean isConfigured() {
        return configured;
    }

    /** Hex colour of buttons and accents. */
    public String getPrimaryColor() {
        return primaryColor;
    }

    /** Hex colour of dividers. */
    public String getSecondaryColor() {
        return secondaryColor;
    }

    /** Hex colour of body text. */
    public String getTextColor() {
        return textColor;
    }

    /** Hex colour of the email background. */
    public String getBackgroundColor() {
        return backgroundColor;
    }

    /** Hex colour of links. */
    public String getLinkColor() {
        return linkColor;
    }

    /** Up to six more hex colours the editors' colour pickers offer. */
    public List<String> getSwatches() {
        return swatches;
    }

    /** The CSS font stack of headings. */
    public String getHeadingFontFamily() {
        return headingFontFamily;
    }

    /** The CSS font stack of body text. */
    public String getBodyFontFamily() {
        return bodyFontFamily;
    }

    /** Button corner radius in pixels. */
    public double getButtonRadius() {
        return buttonRadius;
    }

    /** Button padding left and right, in pixels. */
    public double getButtonPaddingX() {
        return buttonPaddingX;
    }

    /** Button padding top and bottom, in pixels. */
    public double getButtonPaddingY() {
        return buttonPaddingY;
    }

    /** Email content width in pixels. */
    public double getBaseWidth() {
        return baseWidth;
    }

    /** The company name above the postal address in the footer. */
    public String getFooterCompanyName() {
        return footerCompanyName;
    }

    /** The postal address in the footer, one line per line. */
    public String getFooterAddress() {
        return footerAddress;
    }

    public List<BrandKitSocialLink> getFooterSocialLinks() {
        return footerSocialLinks;
    }

    /** The email logo, or {@code null}. Set on the brand kit page; the API cannot change it. */
    public BrandKitLogo getLogo() {
        return logo;
    }

    /** The dark-mode logo, or {@code null}. Set on the brand kit page; the API cannot change it. */
    public BrandKitLogo getLogoDark() {
        return logoDark;
    }
}
