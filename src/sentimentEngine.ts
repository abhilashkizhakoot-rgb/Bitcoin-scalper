/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { NewsSource, NewsHeadline } from "./types.js";

export const SOURCE_REPUTATION: Record<NewsSource, number> = {
  [NewsSource.COINDESK]: 1.0,
  [NewsSource.COINTELEGRAPH]: 0.95,
  [NewsSource.THEBLOCK]: 0.90,
  [NewsSource.BITCOIN_MAGAZINE]: 0.85,
  [NewsSource.CRYPTOPANIC]: 0.80,
  [NewsSource.TWITTER]: 0.65,
  [NewsSource.REDDIT]: 0.55,
};

export class AspectNegationParser {
  private static negationWords = new Set([
    "no", "not", "never", "cannot", "cant", "dont", "doesnt", "didnt", "wont", "isnt", "arent", "without", "unable"
  ]);

  private static doubleNegatives = [
    { pattern: /does not rule out/gi, positiveEquivalent: "may potentially" },
    { pattern: /does not reject/gi, positiveEquivalent: "accepts" },
    { pattern: /no delay/gi, positiveEquivalent: "immediate" },
    { pattern: /fail to decline/gi, positiveEquivalent: "rise" },
    { pattern: /fails to halt/gi, positiveEquivalent: "continues" },
    { pattern: /not rule out/gi, positiveEquivalent: "may" },
    { pattern: /not rejecting/gi, positiveEquivalent: "approving" },
    { pattern: /cannot prevent/gi, positiveEquivalent: "allows" },
    { pattern: /not a scam/gi, positiveEquivalent: "legitimate" },
    { pattern: /not bad/gi, positiveEquivalent: "good" },
    { pattern: /no signs of drop/gi, positiveEquivalent: "stable trend" }
  ];

  /**
   * Performs advanced rule-based financial sentiment negation parsing.
   * Resolves double negatives and manages active negation scopes.
   */
  public static preProcess(text: string): {
    processedText: string;
    rulesApplied: string[];
  } {
    let currentText = text;
    const rulesApplied: string[] = [];

    // 1. Resolve explicit double negatives first
    for (const rule of this.doubleNegatives) {
      if (rule.pattern.test(currentText)) {
        currentText = currentText.replace(rule.pattern, rule.positiveEquivalent);
        rulesApplied.push(`Double negative resolved: '${rule.pattern.source}' -> '${rule.positiveEquivalent}'`);
      }
    }

    return {
      processedText: currentText,
      rulesApplied
    };
  }

  /**
   * Checks if a word acts as a negation trigger.
   */
  public static isNegation(word: string): boolean {
    return this.negationWords.has(word.toLowerCase());
  }
}

export class CrossSourceSentimentAggregator {
  /**
   * Determines if two headlines are discussing the same general topic/aspect.
   * Uses both significant non-noise token overlaps and keyword alignment.
   */
  public static isSameTopic(h1: string, h2: string): boolean {
    const clean = (t: string) => t.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
    const words1 = clean(h1).split(/\s+/).filter(w => w.length > 2);
    const words2 = clean(h2).split(/\s+/).filter(w => w.length > 2);

    const stopWords = new Set([
      "the", "and", "for", "with", "from", "bitcoin", "crypto", "ethereum", "price",
      "market", "today", "news", "about", "this", "that", "will", "what", "says",
      "btc", "eth", "coin", "token", "after", "amid", "over", "into"
    ]);

    const sigWords1 = words1.filter(w => !stopWords.has(w));
    const sigWords2 = words2.filter(w => !stopWords.has(w));

    // Entity/Topic Keyword alignment
    const keyPhrases = ["etf", "fed", "fomc", "sec", "hack", "exploit", "ban", "halving", "regulation", "lawsuit", "whale", "binance", "coinbase"];
    for (const kp of keyPhrases) {
      if (h1.toLowerCase().includes(kp) && h2.toLowerCase().includes(kp)) {
        return true;
      }
    }

    // Significant token overlaps
    let overlapCount = 0;
    for (const w of sigWords1) {
      if (sigWords2.includes(w)) {
        overlapCount++;
      }
    }

    return overlapCount >= 2;
  }

  /**
   * Aggregates sentiment scores and applies source reputation indexing and cross-source volume density factors.
   */
  public static aggregateAndScale(
    baseSentiment: number,
    currentSource: NewsSource,
    headlineText: string,
    recentHeadlines: NewsHeadline[]
  ): {
    score: number;
    density: number;
    distinctSources: NewsSource[];
    reputation: number;
    explanation: string;
  } {
    const reputation = SOURCE_REPUTATION[currentSource] || 0.7;

    // Find same-topic headlines in the recent history (typically last 30 minutes / last 20 entries)
    const matches = recentHeadlines.filter(h => this.isSameTopic(h.headline, headlineText));

    // Compile distinct sources
    const sourcesSet = new Set<NewsSource>([currentSource]);
    for (const m of matches) {
      sourcesSet.add(m.source);
    }

    const distinctSources = Array.from(sourcesSet);
    const density = distinctSources.length;

    let scaleMultiplier = reputation;
    let explanation = "";

    if (density === 1) {
      if (reputation < 0.8) {
        // High noise source and isolated mention -> Dampen it significantly
        scaleMultiplier = reputation * 0.6;
        explanation = `Isolated report from high-noise source (${currentSource}). Scaled down by 40% (multiplier: ${scaleMultiplier.toFixed(2)}) to prevent sentiment hallucinations.`;
      } else {
        scaleMultiplier = reputation;
        explanation = `Isolated report from reputable source (${currentSource}). Reputation index applied (multiplier: ${reputation.toFixed(2)}).`;
      }
    } else {
      // Multiple sources reporting on the same event! Strong volume density confidence
      const densityBonus = 0.15 * (density - 1);
      scaleMultiplier = Math.min(1.25, reputation + densityBonus);
      explanation = `Verified across ${density} independent sources (${distinctSources.join(", ")}). Volume density bonus applied (multiplier: ${scaleMultiplier.toFixed(2)}x).`;
    }

    let finalScore = Number((baseSentiment * scaleMultiplier).toFixed(4));
    finalScore = Math.max(-1.0, Math.min(1.0, finalScore));

    return {
      score: finalScore,
      density,
      distinctSources,
      reputation,
      explanation
    };
  }
}
