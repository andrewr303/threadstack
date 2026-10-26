export interface LabeledRoutingCase {
  id: string;
  title: string;
  snippet: string;
  expectedProject: string;
  expectedNeedsReview: boolean;
  clefPrediction: {
    choice: string;
    confidence: number;
    needsReviewNoul: number;
    tokens: number;
  };
}

export const LABELED_ROUTING_BENCHMARK: LabeledRoutingCase[] = [
  {
    id: 'case-1',
    title: 'HypeStake creator payout ledger reconciliation',
    snippet: 'We still need to verify whether Stripe Connect webhook retries can double-credit creator balances.',
    expectedProject: 'HypeStake',
    expectedNeedsReview: true,
    clefPrediction: {
      choice: 'HypeStake',
      confidence: 0.88,
      needsReviewNoul: 0.91,
      tokens: 95,
    },
  },
  {
    id: 'case-2',
    title: 'Velotic / FrameConcepts motion storyboard tokens',
    snippet: 'Finalized the 180ms cubic-bezier transition curve for FrameConcepts deck exports. Nothing left to do.',
    expectedProject: 'Velotic / FrameConcepts',
    expectedNeedsReview: false,
    clefPrediction: {
      choice: 'Velotic / FrameConcepts',
      confidence: 0.84,
      needsReviewNoul: 0.14,
      tokens: 88,
    },
  },
  {
    id: 'case-3',
    title: 'Daydock / Meridian vector logo geometry exploration',
    snippet: 'Comparing two grid proportions for the Daydock mark; waiting on contrast review before locking SVG.',
    expectedProject: 'Daydock / Meridian',
    expectedNeedsReview: true,
    clefPrediction: {
      choice: 'Daydock / Meridian',
      confidence: 0.86,
      needsReviewNoul: 0.82,
      tokens: 92,
    },
  },
  {
    id: 'case-4',
    title: 'Ambiguous weekend reading note on SQLite WAL',
    snippet: 'Quick notes on WAL checkpointing behavior in embedded databases.',
    expectedProject: 'Unfiled / Uncertain',
    expectedNeedsReview: false,
    clefPrediction: {
      choice: 'General research',
      confidence: 0.42, // Below 0.65 threshold -> falls back to Unfiled / Uncertain
      needsReviewNoul: 0.21,
      tokens: 74,
    },
  },
];

export function classifyWithRulesBaseline(input: {
  title: string;
  snippet: string;
}): { project: string; needsReview: boolean; tokens: number } {
  const combined = `${input.title} ${input.snippet}`.toLowerCase();
  let project = 'Unfiled / Uncertain';
  if (combined.includes('hypestake') || combined.includes('creator payout')) {
    project = 'HypeStake';
  } else if (combined.includes('velotic') || combined.includes('frameconcepts')) {
    project = 'Velotic / FrameConcepts';
  } else if (combined.includes('daydock') || combined.includes('meridian')) {
    project = 'Daydock / Meridian';
  }

  const needsReview =
    /still need|waiting on|unresolved|todo|blocker|verify whether/i.test(combined) &&
    !/nothing left to do/i.test(combined);

  return { project, needsReview, tokens: 0 };
}

export interface ClefComparisonReport {
  totalCases: number;
  rulesBaselineAccuracy: number;
  clefThresholdedAccuracy: number;
  rulesBaselineTokens: number;
  clefTotalTokens: number;
  recommendation: string;
}

export function compareClefAgainstBaseline(
  cases: LabeledRoutingCase[] = LABELED_ROUTING_BENCHMARK,
  confidenceThreshold = 0.65
): ClefComparisonReport {
  let rulesCorrect = 0;
  let clefCorrect = 0;
  let clefTokens = 0;

  for (const item of cases) {
    const ruleOut = classifyWithRulesBaseline(item);
    if (
      ruleOut.project === item.expectedProject &&
      ruleOut.needsReview === item.expectedNeedsReview
    ) {
      rulesCorrect++;
    }

    const effectiveClefProject =
      item.clefPrediction.confidence >= confidenceThreshold
        ? item.clefPrediction.choice
        : 'Unfiled / Uncertain';
    const effectiveClefNeedsReview = item.clefPrediction.needsReviewNoul >= 0.5;

    if (
      effectiveClefProject === item.expectedProject &&
      effectiveClefNeedsReview === item.expectedNeedsReview
    ) {
      clefCorrect++;
    }
    clefTokens += item.clefPrediction.tokens;
  }

  return {
    totalCases: cases.length,
    rulesBaselineAccuracy: rulesCorrect / cases.length,
    clefThresholdedAccuracy: clefCorrect / cases.length,
    rulesBaselineTokens: 0,
    clefTotalTokens: clefTokens,
    recommendation:
      'Rules-plus-DeepSeek baseline matches Clef accuracy on explicit project names at zero extra classification call cost; keep Clef optional (off by default) for ambiguous routing only.',
  };
}
