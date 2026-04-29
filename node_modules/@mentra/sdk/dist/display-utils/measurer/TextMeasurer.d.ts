import type { DisplayProfile, ScriptType } from "../profiles/types";
/**
 * Character measurement result with detailed breakdown.
 */
export interface CharMeasurement {
    /** The character measured */
    char: string;
    /** Width in rendered pixels */
    widthPx: number;
    /** The script type of the character */
    script: ScriptType;
    /** Whether width came from glyph map (true) or fallback (false) */
    fromGlyphMap: boolean;
}
/**
 * Text measurement result with detailed breakdown.
 */
export interface TextMeasurement {
    /** The text measured */
    text: string;
    /** Total width in rendered pixels */
    totalWidthPx: number;
    /** Number of characters */
    charCount: number;
    /** Per-character measurements (optional, for debugging) */
    chars?: CharMeasurement[];
}
/**
 * Measures text width in pixels based on a DisplayProfile.
 * All measurements are in actual rendered pixels, not abstract units.
 *
 * Key features:
 * - Pixel-perfect measurement for mapped characters
 * - Uniform-width handling for CJK, Korean, Cyrillic
 * - Safe fallback for unmapped Latin characters
 * - Caching for performance
 */
export declare class TextMeasurer {
    private readonly profile;
    private readonly charCache;
    constructor(profile: DisplayProfile);
    /**
     * Pre-compute rendered widths for all known glyphs.
     */
    private buildCharCache;
    /**
     * Measure the total pixel width of a text string.
     *
     * @param text - The text to measure
     * @returns Width in rendered pixels
     */
    measureText(text: string): number;
    /**
     * Measure text with detailed breakdown of each character.
     *
     * @param text - The text to measure
     * @returns Detailed measurement result
     */
    measureTextDetailed(text: string): TextMeasurement;
    /**
     * Measure a single character's pixel width.
     *
     * IMPORTANT: This is PIXEL-PERFECT measurement, not averaging!
     * - Mapped characters: exact width from glyph map
     * - Uniform scripts (CJK, Korean, Cyrillic): verified uniform width
     * - Unmapped Latin: MAX width fallback (safe, never overflow)
     *
     * @param char - Single character to measure
     * @returns Width in rendered pixels
     */
    measureChar(char: string): number;
    /**
     * Calculate character width (called when not in cache).
     */
    private calculateCharWidth;
    /**
     * Get the raw glyph width (before render formula).
     * Returns undefined for unmapped characters.
     *
     * @param char - Single character
     * @returns Glyph width in pixels, or undefined if not in glyph map
     */
    getGlyphWidth(char: string): number | undefined;
    /**
     * Check if text fits within a pixel width.
     *
     * @param text - Text to check
     * @param maxWidthPx - Maximum width in pixels
     * @returns true if text fits
     */
    fitsInWidth(text: string, maxWidthPx: number): boolean;
    /**
     * Find how many characters fit within a pixel width.
     *
     * @param text - Text to measure
     * @param maxWidthPx - Maximum width in pixels
     * @param startIndex - Starting index (default: 0)
     * @returns Number of characters that fit
     */
    charsThatFit(text: string, maxWidthPx: number, startIndex?: number): number;
    /**
     * Find the pixel position of a character index in text.
     *
     * @param text - Text to measure
     * @param index - Character index
     * @returns Pixel offset from start of text
     */
    getPixelOffset(text: string, index: number): number;
    /**
     * Detect the script type of a character.
     *
     * @param char - Single character
     * @returns Script type
     */
    detectScript(char: string): ScriptType;
    /**
     * Check if a character is from a uniform-width script.
     *
     * @param char - Single character
     * @returns true if character is from CJK, Korean, or Cyrillic
     */
    isUniformWidth(char: string): boolean;
    /**
     * Get the display profile.
     */
    getProfile(): DisplayProfile;
    /**
     * Get the display width in pixels.
     */
    getDisplayWidthPx(): number;
    /**
     * Get the maximum number of lines.
     */
    getMaxLines(): number;
    /**
     * Get the maximum payload size in bytes.
     */
    getMaxPayloadBytes(): number;
    /**
     * Calculate the UTF-8 byte size of text.
     *
     * @param text - Text to measure
     * @returns Byte size
     */
    getByteSize(text: string): number;
    /**
     * Get the width of a hyphen character in rendered pixels.
     */
    getHyphenWidth(): number;
    /**
     * Get the width of a space character in rendered pixels.
     */
    getSpaceWidth(): number;
    /**
     * Clear the character cache.
     * Useful if profile metrics change at runtime.
     */
    clearCache(): void;
}
//# sourceMappingURL=TextMeasurer.d.ts.map