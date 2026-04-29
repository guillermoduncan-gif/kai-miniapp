import type { DisplayProfile } from "../profiles/types";
import { TextMeasurer } from "../measurer/TextMeasurer";
import { TextWrapper } from "../wrapper/TextWrapper";
import type { WrapOptions, WrapResult } from "../wrapper/types";
/**
 * Truncation result with metadata.
 */
export interface TruncateResult {
    /** The truncated text */
    text: string;
    /** Whether text was truncated */
    wasTruncated: boolean;
    /** Width in pixels of truncated text */
    widthPx: number;
    /** Original text length */
    originalLength: number;
    /** Truncated text length */
    truncatedLength: number;
}
/**
 * Page result for pagination.
 */
export interface Page {
    /** Lines on this page */
    lines: string[];
    /** Page number (1-indexed) */
    pageNumber: number;
    /** Total number of pages */
    totalPages: number;
    /** Whether this is the first page */
    isFirst: boolean;
    /** Whether this is the last page */
    isLast: boolean;
}
/**
 * Chunk result for BLE transmission.
 */
export interface Chunk {
    /** The chunk text */
    text: string;
    /** Chunk index (0-indexed) */
    index: number;
    /** Total number of chunks */
    totalChunks: number;
    /** Byte size of this chunk */
    bytes: number;
}
/**
 * Optional helper utilities for common display operations.
 * Built on top of TextMeasurer and TextWrapper for convenience.
 */
export declare class DisplayHelpers {
    private readonly measurer;
    private readonly wrapper;
    private readonly profile;
    constructor(measurer: TextMeasurer, wrapper: TextWrapper);
    /**
     * Truncate lines array to max count.
     *
     * @param lines - Array of lines
     * @param maxLines - Maximum lines to keep
     * @param fromEnd - If true, keep last N lines; if false, keep first N (default: false)
     * @returns Truncated lines array
     */
    truncateToLines(lines: string[], maxLines: number, fromEnd?: boolean): string[];
    /**
     * Truncate text to fit within pixel width, adding ellipsis if needed.
     *
     * @param text - Text to truncate
     * @param maxWidthPx - Maximum width in pixels
     * @param ellipsis - Ellipsis string (default: '...')
     * @returns Truncation result
     */
    truncateWithEllipsis(text: string, maxWidthPx?: number, ellipsis?: string): TruncateResult;
    /**
     * Estimate how many lines text will need without fully wrapping.
     * This is a quick estimate based on average character width.
     *
     * @param text - Text to estimate
     * @param maxWidthPx - Optional width override
     * @returns Estimated line count
     */
    estimateLineCount(text: string, maxWidthPx?: number): number;
    /**
     * Wrap and truncate text to fit screen in one call.
     *
     * @param text - Text to fit
     * @param options - Wrap options
     * @returns Lines that fit on screen
     */
    fitToScreen(text: string, options?: WrapOptions): string[];
    /**
     * Wrap text and paginate into screen-sized pages.
     *
     * @param text - Text to paginate
     * @param options - Wrap options (maxLines will be used as page size)
     * @returns Array of pages
     */
    paginate(text: string, options?: WrapOptions): Page[];
    /**
     * Calculate UTF-8 byte size of text.
     *
     * @param text - Text to measure
     * @returns Byte size
     */
    calculateByteSize(text: string): number;
    /**
     * Check if text exceeds byte limit.
     *
     * @param text - Text to check
     * @param maxBytes - Optional override (defaults to profile)
     * @returns true if exceeds limit
     */
    exceedsByteLimit(text: string, maxBytes?: number): boolean;
    /**
     * Split text into BLE-safe chunks.
     * Tries to split at word/line boundaries when possible.
     *
     * @param text - Text to chunk
     * @param chunkSize - Optional override (defaults to profile)
     * @returns Array of chunks
     */
    splitIntoChunks(text: string, chunkSize?: number): Chunk[];
    /**
     * Calculate line utilization statistics.
     *
     * @param result - Wrap result to analyze
     * @returns Utilization statistics
     */
    calculateUtilization(result: WrapResult): {
        averageUtilization: number;
        minUtilization: number;
        maxUtilization: number;
        totalWastedPx: number;
    };
    /**
     * Pad lines array to exact count with empty strings.
     *
     * @param lines - Lines to pad
     * @param targetCount - Target number of lines
     * @param padAtEnd - If true, pad at end; if false, pad at start (default: true)
     * @returns Padded lines array
     */
    padToLineCount(lines: string[], targetCount: number, padAtEnd?: boolean): string[];
    /**
     * Join lines with newlines for display.
     *
     * @param lines - Lines to join
     * @returns Joined string
     */
    joinLines(lines: string[]): string;
    /**
     * Get the measurer instance.
     */
    getMeasurer(): TextMeasurer;
    /**
     * Get the wrapper instance.
     */
    getWrapper(): TextWrapper;
    /**
     * Get the display profile.
     */
    getProfile(): DisplayProfile;
}
//# sourceMappingURL=DisplayHelpers.d.ts.map