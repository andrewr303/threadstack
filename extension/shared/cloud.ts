import { z } from 'zod';

export const DEEPSEEK_MODEL_ID = '@cf/deepseek-ai/deepseek-v4.1-flash-1017' as const;
export const CLEF_MODEL_ID = '@cf/cloudflare/clef' as const;

export const VOYAGE_STANDARD_MODELS = ['voyage-4', 'voyage-4-large'] as const;
export const VOYAGE_CONTEXT_MODELS = ['voyage-context-4'] as const;
export const VOYAGE_RERANK_MODELS = ['rerank-3-lite', 'rerank-3'] as const;

export type VoyageStandardModel = (typeof VOYAGE_STANDARD_MODELS)[number];
export type VoyageContextModel = (typeof VOYAGE_CONTEXT_MODELS)[number];
export type VoyageRerankModel = (typeof VOYAGE_RERANK_MODELS)[number];

export const VOYAGE_DIMENSIONS = [256, 512, 1024, 2048] as const;
export type VoyageDimension = (typeof VOYAGE_DIMENSIONS)[number];

export const MONGODB_AI_HOSTS = {
  unscoped: 'https://ai.mongodb.com/v1',
  us: 'https://us.ai.mongodb.com/v1',
  eu: 'https://eu.ai.mongodb.com/v1',
} as const;

export type MongoDbAiGeography = keyof typeof MONGODB_AI_HOSTS;

export const CaptureCoverageSchema = z.enum([
  'title_only',
  'metadata_only',
  'partial',
  'full',
]);
export type CaptureCoverage = z.infer<typeof CaptureCoverageSchema>;

export const WorkflowStatusSchema = z.enum([
  'active',
  'needs_review',
  'waiting',
  'paused',
  'done',
  'reference',
]);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const SourceMessageInputSchema = z.object({
  ordinal: z.number().int().min(1),
  messageId: z.string().min(1).max(200),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string().min(1).max(32000),
  timestamp: z.string().nullable().optional(),
});
export type SourceMessageInput = z.infer<typeof SourceMessageInputSchema>;

export const EvidenceAnchorSchema = z.object({
  messageOrdinal: z.number().int().min(1),
  messageId: z.string().min(1).max(200),
  quote: z.string().min(12).max(600),
  sourceRevision: z.string().min(1).max(128),
  provenance: z.enum(['explicit', 'inferred']),
  commitment: z.enum(['user_committed', 'assistant_suggested']),
});
export type EvidenceAnchor = z.infer<typeof EvidenceAnchorSchema>;

export const ExtractedClaimItemSchema = z.object({
  id: z.string().min(1).max(120),
  kind: z.enum(['decision', 'action', 'constraint', 'question']),
  text: z.string().min(1).max(500),
  anchor: EvidenceAnchorSchema,
});
export type ExtractedClaimItem = z.infer<typeof ExtractedClaimItemSchema>;

export const StructuredSummaryOutputSchema = z.object({
  suggestedAlias: z.string().min(1).max(160).nullable(),
  oneSentenceOverview: z.string().min(1).max(320),
  overviewAnchor: EvidenceAnchorSchema,
  expandedSummary: z.string().min(1).max(2000),
  userGoal: z.string().min(1).max(500).nullable(),
  latestDevelopment: z.string().min(1).max(500).nullable(),
  whereLeftOff: z.string().min(1).max(500),
  whereLeftOffAnchor: EvidenceAnchorSchema,
  changedSinceLastReview: z.string().min(1).max(500).nullable(),
  suggestedWorkflowStatus: WorkflowStatusSchema.nullable(),
  suggestedProjectName: z.string().min(1).max(120).nullable(),
  suggestedWorkstream: z.string().min(1).max(120).nullable(),
  suggestedTags: z.array(z.string().min(1).max(60)).max(8),
  claims: z.array(ExtractedClaimItemSchema).max(24),
  importantOutputs: z.array(
    z.object({
      label: z.string().min(1).max(200),
      kind: z.enum(['code', 'document', 'link', 'artifact']),
      messageOrdinal: z.number().int().min(1),
    })
  ).max(12),
  confidence: z.number().min(0).max(1),
});
export type StructuredSummaryOutput = z.infer<typeof StructuredSummaryOutputSchema>;

export const EnrichThreadRequestSchema = z.object({
  threadKey: z.string().min(1).max(300),
  sourceRevision: z.string().min(1).max(128),
  previousReviewedRevision: z.string().min(1).max(128).nullable().optional(),
  coverage: CaptureCoverageSchema,
  originalTitle: z.string().min(1).max(300),
  messages: z.array(SourceMessageInputSchema).min(1).max(200),
  candidateProjects: z.array(z.string().min(1).max(120)).max(50),
  establishedTags: z.array(z.string().min(1).max(60)).max(100),
  promptVersion: z.string().min(1).max(40).default('v1'),
  model: z.literal(DEEPSEEK_MODEL_ID).default(DEEPSEEK_MODEL_ID),
  reasoningEffort: z.enum(['none', 'low', 'high', 'max']).default('low'),
  maxCompletionTokens: z.number().int().min(128).max(4096).default(1200),
});
export type EnrichThreadRequest = z.infer<typeof EnrichThreadRequestSchema>;

export const AllowedBulkOperationKindSchema = z.enum([
  'assign_project',
  'assign_workstream',
  'add_tag',
  'remove_tag',
  'set_status',
  'lock_category',
]);
export type AllowedBulkOperationKind = z.infer<typeof AllowedBulkOperationKindSchema>;

export const ProposedThreadOperationSchema = z.object({
  threadKey: z.string().min(1).max(300),
  confidence: z.enum(['certain', 'uncertain']),
  rationale: z.string().min(1).max(300),
  operations: z.array(
    z.object({
      op: AllowedBulkOperationKindSchema,
      value: z.string().min(1).max(160),
    })
  ).min(1).max(6),
});
export type ProposedThreadOperation = z.infer<typeof ProposedThreadOperationSchema>;

export const OrganizePreviewRequestSchema = z.object({
  instruction: z.string().min(3).max(600),
  candidateProjects: z.array(z.string().min(1).max(120)).max(50),
  establishedTags: z.array(z.string().min(1).max(60)).max(100),
  threads: z.array(
    z.object({
      threadKey: z.string().min(1).max(300),
      title: z.string().min(1).max(300),
      summary: z.string().max(600),
      currentProject: z.string().nullable(),
      currentWorkstream: z.string().nullable(),
      tags: z.array(z.string()),
      categoryLocked: z.boolean(),
    })
  ).min(1).max(100),
});
export type OrganizePreviewRequest = z.infer<typeof OrganizePreviewRequestSchema>;

export const OrganizePreviewResponseSchema = z.object({
  explanation: z.string().min(1).max(500),
  proposals: z.array(ProposedThreadOperationSchema),
  excludedThreadKeys: z.array(z.string()),
});
export type OrganizePreviewResponse = z.infer<typeof OrganizePreviewResponseSchema>;

export const HandoffRequestSchema = z.object({
  threadKey: z.string().min(1).max(300),
  sourceRevision: z.string().min(1).max(128),
  originalTitle: z.string().min(1).max(300),
  targetObjective: z.string().min(1).max(400).optional(),
  messages: z.array(SourceMessageInputSchema).min(1).max(100),
});
export type HandoffRequest = z.infer<typeof HandoffRequestSchema>;

export const HandoffResponseSchema = z.object({
  goal: z.string().min(1).max(500),
  decisions: z.array(z.string().min(1).max(300)).max(12),
  constraints: z.array(z.string().min(1).max(300)).max(12),
  relevantSources: z.array(
    z.object({
      messageOrdinal: z.number().int().min(1),
      excerpt: z.string().min(1).max(400),
    })
  ).max(10),
  unresolvedQuestions: z.array(z.string().min(1).max(300)).max(10),
  handoffMarkdown: z.string().min(1).max(4000),
});
export type HandoffResponse = z.infer<typeof HandoffResponseSchema>;

export const ClefQuestionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('noul'),
    question: z.string().min(1).max(400),
  }),
  z.object({
    type: z.literal('choice'),
    question: z.string().min(1).max(400),
    options: z.array(z.string().min(1).max(120)).min(2).max(25),
  }),
  z.object({
    type: z.literal('score'),
    question: z.string().min(1).max(400),
    levels: z.record(z.string(), z.string()),
  }),
]);
export type ClefQuestion = z.infer<typeof ClefQuestionSchema>;

export const ClefEvaluateRequestSchema = z.object({
  threadKey: z.string().min(1).max(300),
  state: z.string().min(1).max(16000),
  candidateProjects: z.array(z.string().min(1).max(120)).min(1).max(20),
  confidenceThreshold: z.number().min(0.1).max(0.99).default(0.65),
});
export type ClefEvaluateRequest = z.infer<typeof ClefEvaluateRequestSchema>;

export const ClefAnswerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('noul'),
    noul: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number().min(0).max(1)),
    confidence: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    legend: z.record(z.string(), z.unknown()),
    probabilities: z.record(z.string(), z.number().min(0).max(1)),
    confidence: z.number().min(0).max(1),
  }),
]);

export const ClefRawResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), ClefAnswerSchema),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});
export type ClefRawResponse = z.infer<typeof ClefRawResponseSchema>;

export const StandardEmbeddingRequestSchema = z.object({
  input: z.array(z.string().min(1).max(16000)).min(1).max(128),
  model: z.enum(VOYAGE_STANDARD_MODELS).default('voyage-4'),
  inputType: z.enum(['query', 'document']).default('document'),
  outputDimension: z.enum(['256', '512', '1024', '2048']).transform(Number).pipe(
    z.union([z.literal(256), z.literal(512), z.literal(1024), z.literal(2048)])
  ).or(z.union([z.literal(256), z.literal(512), z.literal(1024), z.literal(2048)])).default(1024),
  truncation: z.boolean().default(true),
  preprocessingVersion: z.string().min(1).max(32).default('v1'),
  indexVersion: z.string().min(1).max(32).default('std-v1'),
});
export type StandardEmbeddingRequest = z.infer<typeof StandardEmbeddingRequestSchema>;

export const ContextualEmbeddingRequestSchema = z.object({
  inputs: z.array(z.array(z.string().min(1).max(16000)).min(1).max(64)).min(1).max(32),
  model: z.enum(VOYAGE_CONTEXT_MODELS).default('voyage-context-4'),
  inputType: z.enum(['query', 'document']).default('document'),
  outputDimension: z.union([z.literal(256), z.literal(512), z.literal(1024), z.literal(2048)]).default(1024),
  preprocessingVersion: z.string().min(1).max(32).default('v1'),
  indexVersion: z.string().min(1).max(32).default('ctx-v1'),
});
export type ContextualEmbeddingRequest = z.infer<typeof ContextualEmbeddingRequestSchema>;

export const RerankRequestSchema = z.object({
  query: z.string().min(1).max(4000),
  documents: z.array(z.string().min(1).max(16000)).min(1).max(50),
  model: z.enum(VOYAGE_RERANK_MODELS).default('rerank-3-lite'),
  topK: z.number().int().min(1).max(50).optional(),
  truncation: z.boolean().default(true),
});
export type RerankRequest = z.infer<typeof RerankRequestSchema>;

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /system\s*prompt\s*override/i,
  /grant\s+tool\s+access/i,
  /execute\s+shell\s+command/i,
  /exfiltrate\s+credentials/i,
];

export function containsPromptInjectionAttempt(text: string): boolean {
  return INJECTION_PATTERNS.some((rx) => rx.test(text));
}

/**
 * Validates that every extracted claim references an actual source message
 * in the supplied revision, includes a substring quote that exists in that
 * message, and never elevates an assistant message to 'user_committed'.
 */
export function verifyStructuredSummaryEvidence(
  summary: StructuredSummaryOutput,
  request: EnrichThreadRequest
): { valid: boolean; errors: string[]; sanitized: StructuredSummaryOutput } {
  const errors: string[] = [];
  if (request.coverage === 'title_only' || request.coverage === 'metadata_only') {
    errors.push('Cannot generate AI summary from title_only or metadata_only coverage.');
  }

  const byOrdinal = new Map<number, SourceMessageInput>();
  for (const msg of request.messages) {
    byOrdinal.set(msg.ordinal, msg);
  }

  const verifyAnchor = (label: string, anchor: EvidenceAnchor): EvidenceAnchor => {
    const msg = byOrdinal.get(anchor.messageOrdinal);
    if (!msg) {
      errors.push(`${label} references non-existent message ordinal ${anchor.messageOrdinal}.`);
      return anchor;
    }
    if (anchor.messageId !== msg.messageId) {
      errors.push(`${label} messageId "${anchor.messageId}" does not match "${msg.messageId}".`);
    }
    if (anchor.sourceRevision !== request.sourceRevision) {
      errors.push(`${label} sourceRevision mismatch.`);
    }
    const normalizedMsg = msg.content.replace(/\s+/g, ' ').trim().toLowerCase();
    const normalizedQuote = anchor.quote.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalizedQuote.length < 12 || !normalizedMsg.includes(normalizedQuote)) {
      errors.push(`${label} quote is not grounded in message #${msg.ordinal}.`);
    }
    return {
      ...anchor,
      commitment: msg.role === 'user' ? anchor.commitment : 'assistant_suggested',
    };
  };

  const sanitizedOverviewAnchor = verifyAnchor('overviewAnchor', summary.overviewAnchor);
  const sanitizedWhereLeftOffAnchor = verifyAnchor('whereLeftOffAnchor', summary.whereLeftOffAnchor);

  const verifiedClaims: ExtractedClaimItem[] = [];
  for (const claim of summary.claims) {
    const msg = byOrdinal.get(claim.anchor.messageOrdinal);
    if (!msg) {
      errors.push(`Claim "${claim.id}" references non-existent message ordinal ${claim.anchor.messageOrdinal}.`);
      continue;
    }
    if (claim.anchor.messageId !== msg.messageId) {
      errors.push(`Claim "${claim.id}" messageId "${claim.anchor.messageId}" does not match "${msg.messageId}".`);
      continue;
    }
    if (claim.anchor.sourceRevision !== request.sourceRevision) {
      errors.push(`Claim "${claim.id}" sourceRevision mismatch.`);
      continue;
    }
    const normalizedMsg = msg.content.replace(/\s+/g, ' ').trim().toLowerCase();
    const normalizedQuote = claim.anchor.quote.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalizedQuote.length < 12 || !normalizedMsg.includes(normalizedQuote)) {
      errors.push(`Claim "${claim.id}" quote is not grounded in message #${msg.ordinal}.`);
      continue;
    }
    if (containsPromptInjectionAttempt(claim.text)) {
      errors.push(`Claim "${claim.id}" contains untrusted directive text.`);
      continue;
    }
    // Enforce: assistant messages cannot be marked as user_committed
    const enforcedCommitment =
      msg.role === 'user' ? claim.anchor.commitment : 'assistant_suggested';

    verifiedClaims.push({
      ...claim,
      anchor: {
        ...claim.anchor,
        commitment: enforcedCommitment,
      },
    });
  }

  const verifiedOutputs = summary.importantOutputs.filter((out) => {
    const exists = byOrdinal.has(out.messageOrdinal);
    if (!exists) {
      errors.push(`Output "${out.label}" references missing message #${out.messageOrdinal}.`);
    }
    return exists;
  });

  if (
    containsPromptInjectionAttempt(summary.oneSentenceOverview) ||
    containsPromptInjectionAttempt(summary.expandedSummary) ||
    containsPromptInjectionAttempt(summary.whereLeftOff)
  ) {
    errors.push('Summary text contains untrusted prompt injection directive.');
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitized: {
      ...summary,
      overviewAnchor: sanitizedOverviewAnchor,
      whereLeftOffAnchor: sanitizedWhereLeftOffAnchor,
      claims: verifiedClaims,
      importantOutputs: verifiedOutputs,
    },
  };
}
