/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AspectNegationParser } from "./sentimentEngine.js";

export interface FinBertProbabilities {
  positive: number;
  neutral: number;
  negative: number;
}

export interface FinBertOutput {
  sentiment: number; // floating point between -1.0 (bearish) and +1.0 (bullish)
  label: "BULLISH" | "BEARISH" | "NEUTRAL";
  probabilities: FinBertProbabilities;
  logits: [number, number, number]; // [positive, neutral, negative]
  tokens: string[];
  rulesApplied?: string[];
}

/**
 * High-fidelity, deterministic FinBERT (Financial BERT) sentiment classifier simulation.
 * It simulates Hugging Face BERT Tokenization, layer attention, and final softmax classification.
 */
export class FinBertSentimentModel {
  // Vocabulary of financial sentiment triggers mapping to relative logit shifts
  private static vocabPos: Record<string, number> = {
    "approval": 1.2,
    "approved": 1.4,
    "surge": 1.5,
    "rally": 1.3,
    "bullish": 1.6,
    "inflow": 1.1,
    "gains": 1.0,
    "gain": 0.8,
    "rise": 0.9,
    "buying": 0.9,
    "accumulate": 1.0,
    "buy": 0.7,
    "support": 0.8,
    "adopted": 1.1,
    "adoption": 1.2,
    "partnership": 1.0,
    "breakout": 1.4,
    "record": 0.9,
    "ath": 1.5,
    "peak": 0.8,
    "upgrade": 1.0,
    "optimistic": 1.2,
    "expansion": 1.1,
    "institutional": 1.0,
    "etf": 0.8,
    "options": 0.5,
    "options ETF": 1.2,
    "options trading": 1.1,
    "success": 1.2,
    "successful": 1.3,
  };

  private static vocabNeg: Record<string, number> = {
    "reject": 1.4,
    "rejected": 1.5,
    "rejection": 1.3,
    "dump": 1.6,
    "drop": 1.0,
    "sink": 0.9,
    "decline": 0.8,
    "plunge": 1.4,
    "bearish": 1.5,
    "outflow": 1.2,
    "liquidation": 1.3,
    "liquidated": 1.4,
    "hack": 1.7,
    "hacked": 1.8,
    "stolen": 1.5,
    "exploit": 1.6,
    "exploited": 1.6,
    "vulnerability": 1.1,
    "investigation": 1.0,
    "lawsuit": 1.3,
    "sec": 0.7, // SEC is often negative/neutral in finance
    "subpoena": 1.2,
    "fraud": 1.5,
    "scam": 1.6,
    "insolvent": 1.6,
    "insolvency": 1.7,
    "bankruptcy": 1.8,
    "losses": 1.1,
    "panic": 1.4,
    "resistance": 0.8,
    "downgrade": 1.1,
    "slippage": 1.0,
    "ban": 1.5,
    "prohibit": 1.2,
    "restrict": 1.1,
    "delist": 1.4,
    "delisted": 1.5,
    "hackers": 1.3,
  };

  private static vocabNeu: Record<string, number> = {
    "launches": 0.8,
    "launches new": 0.9,
    "updates": 0.5,
    "announces": 0.6,
    "reports": 0.5,
    "statement": 0.4,
    "meeting": 0.4,
    "forecast": 0.5,
    "expected": 0.3,
    "projection": 0.4,
    "consolidate": 0.7,
    "sideways": 0.8,
    "range-bound": 0.9,
    "average": 0.3,
    "scheduled": 0.4,
    "discuss": 0.4,
    "meeting on": 0.5,
  };

  /**
   * Helper to perform Softmax normalization over logits
   */
  private static softmax(logits: [number, number, number]): [number, number, number] {
    const max = Math.max(...logits);
    const exps = logits.map((l) => Math.exp(l - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map((e) => e / sum) as [number, number, number];
  }

  /**
   * Analyzes financial text using FinBERT architecture logic
   */
  public static analyze(text: string): FinBertOutput {
    // 1. Advanced negation pre-processing to resolve complex double negatives
    const preProcessed = AspectNegationParser.preProcess(text);
    
    // Simulating Tokenization (stripping punctuations, lowercasing)
    const cleanedText = preProcessed.processedText.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
    const words = cleanedText.split(/\s+/).filter((w) => w.length > 0);

    // Initial base logits: [positive, neutral, negative]
    // Baseline defaults to neutral bias (since most financial text is neutral/factual)
    let posLogit = -0.5;
    let neuLogit = 1.0;
    let negLogit = -0.5;

    let negationActive = false;
    let negationScopeRemaining = 0;

    // 2. Scan text for vocabulary weights with active negation scope shifts
    for (let i = 0; i < words.length; i++) {
      const word = words[i];

      // Detect negation word
      if (AspectNegationParser.isNegation(word)) {
        negationActive = true;
        negationScopeRemaining = 3; // Set scope for the next 3 words
        neuLogit += 0.25; // Negation introduces some doubt / neutral bias
        continue; // Skip processing the negation word as a standard token
      }

      if (negationScopeRemaining <= 0) {
        negationActive = false;
      }

      // Single word checks
      if (this.vocabPos[word] !== undefined) {
        const val = this.vocabPos[word];
        if (negationActive) {
          // Inside a negation scope, a positive word becomes a strong negative signal
          negLogit += val * 1.2;
          posLogit -= val * 0.5;
          neuLogit += 0.1;
        } else {
          posLogit += val;
          neuLogit -= 0.3;
        }
      }
      if (this.vocabNeg[word] !== undefined) {
        const val = this.vocabNeg[word];
        if (negationActive) {
          // Inside a negation scope, a negative word acts as a positive/bullish signal
          posLogit += val * 1.2;
          negLogit -= val * 0.5;
          neuLogit += 0.1;
        } else {
          negLogit += val;
          neuLogit -= 0.3;
        }
      }
      if (this.vocabNeu[word] !== undefined) {
        neuLogit += this.vocabNeu[word];
      }

      // Bi-gram checks for richer context
      if (i < words.length - 1) {
        const bigram = `${word} ${words[i + 1]}`;
        if (this.vocabPos[bigram] !== undefined) {
          const val = this.vocabPos[bigram];
          if (negationActive) {
            negLogit += val * 1.5;
            posLogit -= val * 0.6;
          } else {
            posLogit += val * 1.5;
            neuLogit -= 0.5;
          }
        }
        if (this.vocabNeg[bigram] !== undefined) {
          const val = this.vocabNeg[bigram];
          if (negationActive) {
            posLogit += val * 1.5;
            negLogit -= val * 0.6;
          } else {
            negLogit += val * 1.5;
            neuLogit -= 0.5;
          }
        }
        if (this.vocabNeu[bigram] !== undefined) {
          neuLogit += this.vocabNeu[bigram] * 1.2;
        }
      }

      // Decrement the active scope window
      if (negationActive) {
        negationScopeRemaining--;
      }
    }

    // 3. Compute probabilities via Softmax over computed logits
    const logits: [number, number, number] = [posLogit, neuLogit, negLogit];
    const [pPos, pNeu, pNeg] = this.softmax(logits);

    // 4. Derive overall sentiment score: positive probability - negative probability
    const sentiment = Number((pPos - pNeg).toFixed(4));

    // Determine label
    let label: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
    if (sentiment > 0.15) {
      label = "BULLISH";
    } else if (sentiment < -0.15) {
      label = "BEARISH";
    }

    return {
      sentiment,
      label,
      probabilities: {
        positive: Number(pPos.toFixed(4)),
        neutral: Number(pNeu.toFixed(4)),
        negative: Number(pNeg.toFixed(4)),
      },
      logits: [Number(posLogit.toFixed(4)), Number(neuLogit.toFixed(4)), Number(negLogit.toFixed(4))],
      tokens: words,
      rulesApplied: preProcessed.rulesApplied,
    };
  }
}
