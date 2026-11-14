import {
  CLEF_MODEL_ID,
  ClefEvaluateRequest,
  ClefRawResponse,
  ClefRawResponseSchema,
} from '../../shared/cloud';
import type { Env } from '../worker-configuration';

export function buildClefEndpointUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${CLEF_MODEL_ID}`;
}

export interface ClefDecisionOutput {
  recommendedProject: string;
  projectConfidence: number;
  projectProbabilities: Record<string, number>;
  needsReviewProbability: number;
  shouldResummarizeProbability: number;
  recommendedRoute: 'skip' | 'local_rules_only' | 'deepseek_enrich';
  autoApplyEligible: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Invokes `@cf/cloudflare/clef` using its documented state-plus-typed-questions
 * interface (`/ai/run/@cf/cloudflare/clef` with `model: "clef"`, `state`, `questions`).
 * Never routes Clef through Chat Completions.
 */
export async function evaluateWithClef(
  env: Env,
  req: ClefEvaluateRequest,
  fetchImpl: typeof fetch = fetch
): Promise<ClefDecisionOutput> {
  if (env.ENABLE_CLEF !== 'true') {
    throw new Error('Clef classification is disabled by policy (ENABLE_CLEF !== "true").');
  }

  const optionsWithUncertain = Array.from(
    new Set([...req.candidateProjects, 'Unfiled / Uncertain'])
  );

  const clefRequestPayload = {
    model: 'clef',
    state: req.state,
    questions: {
      project_fit: {
        type: 'choice',
        question: 'Which existing project area best fits this conversation transcript?',
        options: optionsWithUncertain,
      },
      needs_review: {
        type: 'noul',
        question: 'Does this conversation have an unfinished question, blocker, or pending review item?',
      },
      changed_enough: {
        type: 'noul',
        question: 'Did the conversation change substantially enough to warrant re-summarization?',
      },
      processing_route: {
        type: 'choice',
        question: 'Which processing route is appropriate for this thread?',
        options: ['skip', 'local_rules_only', 'deepseek_enrich'],
      },
    },
  };

  let rawPayload: unknown;

  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_AI_API_TOKEN) {
    const res = await fetchImpl(buildClefEndpointUrl(env.CLOUDFLARE_ACCOUNT_ID), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.CLOUDFLARE_AI_API_TOKEN}`,
      },
      body: JSON.stringify(clefRequestPayload),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Clef request failed (${res.status}): ${detail.slice(0, 300)}`);
    }

    const body = (await res.json()) as { result?: unknown };
    rawPayload = body.result ?? body;
  } else if (env.AI) {
    rawPayload = await env.AI.run(CLEF_MODEL_ID, clefRequestPayload);
  } else {
    throw new Error('Cloudflare credentials are not configured for Clef.');
  }

  const parsed: ClefRawResponse = ClefRawResponseSchema.parse(rawPayload);

  const projectAnswer = parsed.answers['project_fit'];
  if (!projectAnswer || projectAnswer.type !== 'choice') {
    throw new Error('Clef response missing valid choice answer for project_fit.');
  }

  const needsReviewAnswer = parsed.answers['needs_review'];
  if (!needsReviewAnswer || needsReviewAnswer.type !== 'noul') {
    throw new Error('Clef response missing valid noul answer for needs_review.');
  }

  const changedEnoughAnswer = parsed.answers['changed_enough'];
  if (!changedEnoughAnswer || changedEnoughAnswer.type !== 'noul') {
    throw new Error('Clef response missing valid noul answer for changed_enough.');
  }

  const routeAnswer = parsed.answers['processing_route'];
  if (!routeAnswer || routeAnswer.type !== 'choice') {
    throw new Error('Clef response missing valid choice answer for processing_route.');
  }

  const recommendedProject = optionsWithUncertain.includes(projectAnswer.choice)
    ? projectAnswer.choice
    : 'Unfiled / Uncertain';

  const autoApplyEligible =
    recommendedProject !== 'Unfiled / Uncertain' &&
    projectAnswer.confidence >= req.confidenceThreshold;

  const routeChoice =
    routeAnswer.choice === 'skip' ||
    routeAnswer.choice === 'local_rules_only' ||
    routeAnswer.choice === 'deepseek_enrich'
      ? routeAnswer.choice
      : 'local_rules_only';

  return {
    recommendedProject,
    projectConfidence: projectAnswer.confidence,
    projectProbabilities: projectAnswer.probabilities,
    needsReviewProbability: needsReviewAnswer.noul,
    shouldResummarizeProbability: changedEnoughAnswer.noul,
    recommendedRoute: routeChoice,
    autoApplyEligible,
    usage: {
      inputTokens: parsed.usage.input_tokens,
      outputTokens: parsed.usage.output_tokens,
    },
  };
}
