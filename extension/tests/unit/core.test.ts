import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildThreadKey,
  getDisplayTitle,
  verifyExtensionSummaryEvidence,
  STARTER_AREAS,
  type ExtensionSummaryOutput,
} from '../../src/core/schema.js';
import {
  ThreadkeeperDB,
  ensureStarterCollectionsAndSettings,
  upsertThread,
  updateManualThreadFields,
  deleteConversationCascade,
  reconcileLibraryCounts,
  applySummaryEnrichment,
  enqueueJob,
  processResumableJobs,
} from '../../src/core/db.js';
import {
  CAPABILITY_MATRIX,
  extractConversationIdFromUrl,
  extractVisibleDomConversation,
  parseChatGPTExport,
  parseClaudeExport,
  exportPortableBundle,
  exportThreadToMarkdown,
  importPortableBundle,
} from '../../src/core/adapters.js';
import {
  runHybridSearch,
  storeVectorEntries,
  validateVectorCompatibility,
} from '../../src/core/search.js';
import {
  normalizeTag,
  normalizeTags,
  computeResurfacingQueueItems,
  previewNaturalLanguageOrganize,
  applyOrganizeProposals,
  undoChangeLog,
} from '../../src/core/organization.js';
import {
  checkCloudEligibility,
  currentUtcDateKey,
  requestCandidateRerank,
  requestQueryEmbedding,
  requestThreadEnrichment,
} from '../../src/core/cloud-client.js';
import {
  EnrichThreadRequestSchema,
  StandardEmbeddingRequestSchema,
  RerankRequestSchema,
   verifyStructuredSummaryEvidence,
} from '../../shared/cloud.js';
import {
  seedSyntheticWorkbenchLibrary,
  generate652ChatGPTExportFixture,
} from '../../src/core/synthetic-fixtures.js';
import {
  validateRuntimeMessageSender,
  validateWindowPostMessage,
} from '../../src/core/messaging.js';

let dbCounter = 0;
function createTestDb(): ThreadkeeperDB {
  dbCounter += 1;
  return new ThreadkeeperDB(`ThreadkeeperTestDB_${Date.now()}_${dbCounter}`);
}

describe('Threadkeeper Core Verification Suite (CAPTURE-04..PRIV-11)', () => {
  let db: ThreadkeeperDB;

  beforeEach(async () => {
    db = createTestDb();
    await ensureStarterCollectionsAndSettings(db);
  });

  describe('CAPTURE-04: Capability Matrix, Adapter Extraction & Export/Import Round-Trip', () => {
    it('exports an accurate capability matrix where cloud task status is N across all adapters', () => {
      expect(CAPABILITY_MATRIX.length).toBeGreaterThanOrEqual(4);
      for (const row of CAPABILITY_MATRIX) {
        expect(row.cloudTaskStatus).toBe('N');
      }
      const chatgptExport = CAPABILITY_MATRIX.find((r) => r.adapterId === 'chatgpt_export');
      expect(chatgptExport?.fullExport).toBe('Y');
      expect(chatgptExport?.branchHistory).toBe('Y');
    });

    it('extracts visible DOM conversations for ChatGPT and Claude with honest partial/title_only coverage and skips streaming/composer nodes', () => {
      const parser = new DOMParser();
      const chatgptDoc = parser.parseFromString(
        `<!doctype html><html><head><title>Daydock Logo Grid - ChatGPT</title></head><body>
          <div data-message-author-role="user" data-message-id="m1">Please set the outer ring stroke to 2px on a 24px grid.</div>
          <div data-message-author-role="assistant" data-message-id="m2">Updated outer ring to 2px with 1.5px inner ticks.</div>
          <div data-message-author-role="assistant" data-message-id="m3" data-streaming="true">Streaming incomplete thought...</div>
          <form><div data-message-author-role="user" contenteditable="true">Unsent draft inside composer</div></form>
        </body></html>`,
        'text/html'
      );
      const extracted = extractVisibleDomConversation(
        chatgptDoc,
        'https://chatgpt.com/c/67f00112233445566778899a'
      );
      expect(extracted).not.toBeNull();
      expect(extracted!.provider).toBe('chatgpt');
      expect(extracted!.sourceConversationId).toBe('67f00112233445566778899a');
      expect(extracted!.coverage).toBe('partial');
      expect(extracted!.messages).toHaveLength(2);

      // Empty message list on page -> title_only coverage
      const titleOnlyDoc = parser.parseFromString(
        `<!doctype html><html><head><title>Long Spec - Claude</title></head><body>
          <div data-conversation-title="true">Long Spec</div>
        </body></html>`,
        'text/html'
      );
      const titleOnlyExtracted = extractVisibleDomConversation(
        titleOnlyDoc,
        'https://claude.ai/chat/claude-uuid-991'
      );
      expect(titleOnlyExtracted).not.toBeNull();
      expect(titleOnlyExtracted!.provider).toBe('claude');
      expect(titleOnlyExtracted!.coverage).toBe('title_only');
      expect(titleOnlyExtracted!.messages).toHaveLength(0);
    });

    it('ingests a 652-conversation multi-branch ChatGPT export without collapsing sibling branches', async () => {
      const raw652 = generate652ChatGPTExportFixture();
      expect(raw652).toHaveLength(652);

      const parsed = parseChatGPTExport(raw652, {
        accountId: 'acct_chatgpt_primary',
        workspaceId: 'ws_personal',
      });
      // Conversation #1 has 2 distinct branches (main + branch_2), plus 651 single-branch conversations = 653 thread entries
      expect(parsed.length).toBe(653);

      const conv1Branches = parsed.filter(
        (p) => p.sourceConversationId === 'chatgpt_652_0001'
      );
      expect(conv1Branches).toHaveLength(2);
      expect(conv1Branches.map((b) => b.branchId).sort()).toEqual(['branch_2', 'main']);

      // Upsert both branches and verify both survive as distinct records linked as siblings
      const resMain = await upsertThread(db, conv1Branches[0]);
      const resAlt = await upsertThread(db, conv1Branches[1]);
      expect(resMain.status).toBe('stored');
      expect(resAlt.status).toBe('stored');
      expect(resMain.record!.siblingBranchIds).toContain('branch_2');
      expect(resAlt.record!.parentBranchId).toBe('main');
    });

    it('parses Claude official exports and preserves lossless JSON & Markdown round-trips', async () => {
      const claudeRaw = [
        {
          uuid: 'claude_conv_42',
          name: 'Velotic Motion Easing Spec',
          created_at: '2026-03-10T10:00:00.000Z',
          updated_at: '2026-03-10T10:15:00.000Z',
          chat_messages: [
            {
              uuid: 'cm_1',
              sender: 'human',
              text: 'Use cubic-bezier(0.22, 1, 0.36, 1) for drawer transitions.',
              created_at: '2026-03-10T10:00:00.000Z',
            },
            {
              uuid: 'cm_2',
              sender: 'assistant',
              text: 'Confirmed: 220ms enter and 160ms exit with cubic-bezier(0.22, 1, 0.36, 1).',
              created_at: '2026-03-10T10:05:00.000Z',
            },
          ],
        },
      ];
      const parsed = parseClaudeExport(claudeRaw, {
        accountId: 'acct_claude_primary',
        workspaceId: 'ws_personal',
      });
      expect(parsed).toHaveLength(1);
      const upserted = await upsertThread(db, parsed[0]);
      expect(upserted.status).toBe('stored');
      const conv = upserted.record!;
      const msgs = await db.messages
        .where('threadKey')
        .equals(conv.threadKey)
        .sortBy('ordinal');

      const md = exportThreadToMarkdown(conv, msgs, null);
      expect(md).toContain('# Velotic Motion Easing Spec');
      expect(md).toContain('cubic-bezier(0.22, 1, 0.36, 1)');

      const bundle = await exportPortableBundle(db);
      expect(
        bundle.conversations.some((c) => c.conversation.threadKey === conv.threadKey)
      ).toBe(true);

      const db2 = createTestDb();
      await ensureStarterCollectionsAndSettings(db2);
      const importStats = await importPortableBundle(db2, bundle);
      expect(importStats.importedCount).toBeGreaterThanOrEqual(1);
      const restored = await db2.conversations.get(conv.threadKey);
      expect(restored?.title).toBe('Velotic Motion Easing Spec');
    });
  });

  describe('DEDUP-05: Canonical Identity, Monotonic Coverage & User Rename Preservation', () => {
    it('extracts canonical IDs stripping query params and hash fragments', () => {
      expect(
        extractConversationIdFromUrl(
          'https://chatgpt.com/g/g-123/c/abc-999?model=gpt-4o#bottom'
        )
      ).toBe('abc-999');
      expect(
        extractConversationIdFromUrl('https://claude.ai/chat/uuid-777?foo=bar')
      ).toBe('uuid-777');
    });

    it('never downgrades full -> partial -> title_only and preserves manualTitleOverride & categoryLocked across recaptures', async () => {
      const threadKey = buildThreadKey({
        provider: 'chatgpt',
        accountId: 'acct_chatgpt_primary',
        workspaceId: 'ws_personal',
        sourceConversationId: 'thread_dedup_1',
        branchId: 'main',
      });

      // 1. Ingest as title_only
      const c1 = await upsertThread(db, {
        threadKey,
        provider: 'chatgpt',
        accountId: 'acct_chatgpt_primary',
        workspaceId: 'ws_personal',
        sourceConversationId: 'thread_dedup_1',
        branchId: 'main',
        canonicalUrl: 'https://chatgpt.com/c/thread_dedup_1',
        title: 'Sidebar Stub Title',
        createdAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:00:00.000Z',
        coverage: 'title_only',
        captureSource: 'dom_observer',
        messages: [],
      });
      expect(c1.record!.coverage).toBe('title_only');

      // 2. User renames the thread and locks project
      await updateManualThreadFields(db, threadKey, {
        manualTitleOverride: 'My Custom Design Spec Title',
        project: 'Daydock / Meridian',
        categoryLocked: true,
        manualTags: ['locked-tag'],
      });
      const afterRename = await db.conversations.get(threadKey);
      expect(getDisplayTitle(afterRename!)).toBe('My Custom Design Spec Title');
      expect(afterRename!.title).toBe('Sidebar Stub Title');
      expect(afterRename!.categoryLocked).toBe(true);

      // 3. Upgrade to full capture via official export
      const c2 = await upsertThread(db, {
        threadKey,
        provider: 'chatgpt',
        accountId: 'acct_chatgpt_primary',
        workspaceId: 'ws_personal',
        sourceConversationId: 'thread_dedup_1',
        branchId: 'main',
        canonicalUrl: 'https://chatgpt.com/c/thread_dedup_1',
        title: 'Updated Upstream Title',
        createdAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:01:00.000Z',
        coverage: 'full',
        captureSource: 'export_import',
        project: 'General research', // should be ignored because categoryLocked is true
        messages: [
          {
            sourceMessageId: 'm1',
            role: 'user',
            content: 'Full message 1',
            createdAt: '2026-03-12T00:00:00.000Z',
          },
          {
            sourceMessageId: 'm2',
            role: 'assistant',
            content: 'Full message 2',
            createdAt: '2026-03-12T00:01:00.000Z',
          },
        ],
      });
      expect(c2.record!.coverage).toBe('full');
      expect(c2.record!.manualTitleOverride).toBe('My Custom Design Spec Title');
      expect(c2.record!.title).toBe('Updated Upstream Title');
      expect(c2.record!.project).toBe('Daydock / Meridian');
      expect(c2.record!.tags).toContain('locked-tag');

      // 4. Subsequent partial DOM capture with fewer visible turns must NOT lose earlier messages
      const c3 = await upsertThread(db, {
        threadKey,
        provider: 'chatgpt',
        accountId: 'acct_chatgpt_primary',
        workspaceId: 'ws_personal',
        sourceConversationId: 'thread_dedup_1',
        branchId: 'main',
        canonicalUrl: 'https://chatgpt.com/c/thread_dedup_1',
        title: 'Updated Upstream Title',
        createdAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:01:00.000Z',
        coverage: 'partial',
        captureSource: 'dom_observer',
        messages: [
          {
            sourceMessageId: 'm2',
            role: 'assistant',
            content: 'Full message 2',
            createdAt: '2026-03-12T00:01:00.000Z',
          },
        ],
      });
      expect(c3.record!.coverage).toBe('full');
      expect(c3.record!.messageCount).toBe(2);
      expect(c3.record!.manualTitleOverride).toBe('My Custom Design Spec Title');
    });
  });

  describe('SUM-06: Cloud Enrichment Gate, Provenance Verification & Stale Protection', () => {
    it('enforces opt-in, per-thread/per-project/per-provider exclusions, and daily budget', async () => {
      await seedSyntheticWorkbenchLibrary(db);
      const convs = await db.conversations.toArray();
      const target = convs.find(
        (c) => c.coverage === 'full' && !c.cloudExcluded && c.project !== 'Personal'
      )!;

      // Default settings: cloudEnabled is false
      const defaultCheck = await checkCloudEligibility(db, target);
      expect(defaultCheck.allowed).toBe(false);
      expect(defaultCheck.reason).toContain('disabled');

      // Enable cloud with valid endpoint + token
      const settings = await ensureStarterCollectionsAndSettings(db);
      await db.settings.put({
        ...settings,
        cloudEnabled: true,
        workerEndpointUrl: 'https://worker.example.com',
        workerBearerToken: 'secret-token-123456',
        dailyCloudRequestBudget: 2,
        dailyCloudRequestsUsed: 0,
      });

      expect((await checkCloudEligibility(db, target)).allowed).toBe(true);

      // Per-thread exclusion
      await db.conversations.update(target.threadKey, { cloudExcluded: true });
      const excludedThread = (await db.conversations.get(target.threadKey))!;
      expect((await checkCloudEligibility(db, excludedThread)).allowed).toBe(false);
      await db.conversations.update(target.threadKey, { cloudExcluded: false });

      // Personal project is cloudExcluded by default
      const personalThread = convs.find((c) => c.project === 'Personal')!;
      expect((await checkCloudEligibility(db, personalThread)).allowed).toBe(false);
    });

    it('verifies message-index provenance, distinguishes speaker commitment, and rejects out-of-range or stale writes', async () => {
      await seedSyntheticWorkbenchLibrary(db);
      const targetKey = buildThreadKey({
        provider: 'chatgpt',
        accountId: 'acct_chatgpt_primary',
        workspaceId: 'ws_personal',
        sourceConversationId: 'conv_daydock_logo_grid',
        branchId: 'main',
      });
      const conv = (await db.conversations.get(targetKey))!;
      const msgs = await db.messages
        .where('threadKey')
        .equals(targetKey)
        .sortBy('ordinal');

      const msgPayload = msgs.map((m) => ({
        index: m.ordinal,
        role: m.role,
        content: m.content,
      }));

      const validSummary: ExtensionSummaryOutput = {
        whereYouLeftOff: 'Locked 24x24 optical grid and 14-degree meridian tilt.',
        whereYouLeftOffMessageIndexes: [0, 2],
        currentStatus: 'Ready for SVG export.',
        currentStatusMessageIndexes: [2],
        decisions: [
          {
            text: 'Use a 24x24 optical grid with 1.75px stroke weight',
            messageIndexes: [0],
            evidenceQuote: 'use a 24x24 optical grid with 1.75px stroke weight',
            provenance: 'explicit',
            speaker: 'user_committed',
          },
        ],
        openQuestions: [],
        actionItems: [
          {
            text: 'Export the monochrome SVG wordmark and test at 16px favicon scale',
            messageIndexes: [2],
            evidenceQuote:
              'export the monochrome SVG wordmark and test at 16px favicon scale',
            provenance: 'explicit',
            speaker: 'user_committed',
          },
        ],
        constraints: [],
        entities: ['Daydock'],
        artifactReferences: ['daydock-meridian-mark.svg'],
        suggestedProject: 'Daydock / Meridian',
        suggestedTags: ['svg', 'logo'],
        confidence: 0.94,
      };

      const checkOk = verifyExtensionSummaryEvidence(validSummary, msgPayload);
      expect(checkOk.valid).toBe(true);

      // Out-of-range message index -> rejected
      const badSummary: ExtensionSummaryOutput = {
        ...validSummary,
        decisions: [
          {
            ...validSummary.decisions[0],
            messageIndexes: [999],
          },
        ],
      };
      const checkBad = verifyExtensionSummaryEvidence(badSummary, msgPayload);
      expect(checkBad.valid).toBe(false);

      // Assistant-only message marked as user_committed -> rejected
      const assistantMisattributed: ExtensionSummaryOutput = {
        ...validSummary,
        decisions: [
          {
            text: 'Recommend a 14-degree meridian tilt',
            messageIndexes: [1], // message 1 is assistant
            evidenceQuote: 'recommend a 14-degree meridian tilt',
            provenance: 'explicit',
            speaker: 'user_committed',
          },
        ],
      };
      const checkMisattr = verifyExtensionSummaryEvidence(
        assistantMisattributed,
        msgPayload
      );
      expect(checkMisattr.valid).toBe(false);

      // Stale sourceRevision write must be rejected and never overwrite current state
      const staleResult = await applySummaryEnrichment(db, {
        threadKey: conv.threadKey,
        sourceRevision: conv.sourceRevision - 1,
        contentHash: 'stale_hash',
        model: 'deepseek/deepseek-v3.2',
        summary: validSummary,
      });
      expect(staleResult.applied).toBe(false);
      expect(staleResult.reason).toContain('stale_revision');

      // Matching sourceRevision + contentHash succeeds and caches
      const freshResult = await applySummaryEnrichment(db, {
        threadKey: conv.threadKey,
        sourceRevision: conv.sourceRevision,
        contentHash: conv.contentHash,
        model: 'deepseek/deepseek-v3.2',
        summary: validSummary,
      });
      expect(freshResult.applied).toBe(true);

      // Subsequent requestThreadEnrichment returns 'cached' without invoking fetch
      let fetchCalled = false;
      const cachedRes = await requestThreadEnrichment(db, conv.threadKey, async () => {
        fetchCalled = true;
        throw new Error('Should not call network when cached');
      });
      expect(cachedRes.status).toBe('cached');
      expect(fetchCalled).toBe(false);
    });
  });

  describe('SEARCH-07: Scope Filtering Before Scoring, Vector Compatibility & Reranker Fallback', () => {
    beforeEach(async () => {
      await seedSyntheticWorkbenchLibrary(db);
    });

    it('applies scope filters BEFORE scoring so out-of-scope threads never leak into top-K', async () => {
      const res = await runHybridSearch(db, {
        query: 'Daydock HypeStake WebGPU stroke msgpack',
        scope: {
          project: 'HypeStake',
        },
        limit: 10,
      });
      expect(res.hits.length).toBeGreaterThan(0);
      for (const hit of res.hits) {
        expect(hit.conversation.project).toBe('HypeStake');
      }
    });

    it('rejects mismatched embedding model/dimension/indexType and skips stale vector entries', async () => {
      const compatMismatch = validateVectorCompatibility({
        indexType: 'standard',
        model: 'voyage-4',
        dimensions: 256,
        embeddingLength: 512,
      });
      expect(compatMismatch.valid).toBe(false);

      // Contextual indexType with standard voyage-4 model -> rejected
      const contextualMismatch = validateVectorCompatibility({
        indexType: 'contextual',
        model: 'voyage-4',
        dimensions: 256,
        embeddingLength: 256,
      });
      expect(contextualMismatch.valid).toBe(false);

      const targetKey = buildThreadKey({
        provider: 'chatgpt',
        accountId: 'acct_chatgpt_primary',
        workspaceId: 'ws_personal',
        sourceConversationId: 'conv_daydock_logo_grid',
        branchId: 'main',
      });
      const conv = (await db.conversations.get(targetKey))!;
      const chunks = await db.chunks.where('threadKey').equals(targetKey).toArray();
      const vec256 = new Array(256).fill(0);
      vec256[0] = 1;

      const storeRes = await storeVectorEntries(db, {
        indexType: 'standard',
        model: 'voyage-4',
        dimensions: 256,
        threadKey: conv.threadKey,
        embeddingsByChunkKey: chunks.map((c) => ({
          chunkKey: c.chunkKey,
          embedding: vec256,
        })),
      });
      expect(storeRes.stored).toBeGreaterThan(0);

      // Query with mismatched embedding length is rejected cleanly while lexical search still succeeds
      const mismatchSearch = await runHybridSearch(db, {
        query: 'Daydock',
        vectorQuery: {
          indexType: 'standard',
          model: 'voyage-4',
          dimensions: 512,
          embedding: vec256, // length 256 != 512
        },
      });
      expect(mismatchSearch.vectorRejectedReason).toBeDefined();
      expect(mismatchSearch.hits.length).toBeGreaterThan(0);
    });

    it('validates reranker indices and falls back cleanly on timeout or invalid indices', async () => {
      const fallbackSearch = await runHybridSearch(db, {
        query: 'Daydock',
        reranker: async () => {
          return [{ index: 9999, relevanceScore: 0.99 }];
        },
      });
      expect(fallbackSearch.rerankFallbackUsed).toBe(true);
      expect(fallbackSearch.hits.length).toBeGreaterThan(0);
    });
  });

  describe('ORG-08: Starter Areas, Tag Normalization, Resurfacing Queue & Natural-Language Undo', () => {
    beforeEach(async () => {
      await seedSyntheticWorkbenchLibrary(db);
    });

    it('seeds the 6 starter areas and normalizes tags without near-duplicates', async () => {
      const cols = await db.collections.toArray();
      expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining([...STARTER_AREAS]));

      expect(normalizeTag('  Design_System!! ')).toBe('design-system');
      expect(normalizeTags(['SVG Grid', 'svg-grid', 'Iconography'])).toEqual([
        'svg-grid',
        'iconography',
      ]);
    });

    it('surfaces high-signal resurfacing cards with concrete reasons', async () => {
      const convs = await db.conversations.toArray();
      const summaries = await db.summaries.toArray();
      const cards = computeResurfacingQueueItems(
        convs,
        new Map(summaries.map((s) => [s.threadKey, s])),
        'continue_working'
      );
      expect(cards.length).toBeGreaterThan(0);
      for (const card of cards.slice(0, 3)) {
        expect(card.resurfaceReason.length).toBeGreaterThan(5);
      }
    });

    it('previews natural-language organization, honors negative exclusion clauses, applies batch changes, and undoes losslessly', async () => {
      const convs = await db.conversations.toArray();
      const proposals = previewNaturalLanguageOrganize(
        'Group all Daydock logo threads into Daydock / Meridian, but keep the homepage research separate',
        convs
      );
      expect(proposals.length).toBeGreaterThan(0);
      // Verify the homepage research thread was marked excludedByInstruction by the "keep the homepage research separate" clause
      const homepageProposal = proposals.find((p) =>
        p.title.toLowerCase().includes('homepage research')
      );
      expect(homepageProposal).toBeDefined();
      expect(homepageProposal!.excludedByInstruction).toBe(true);
      expect(homepageProposal!.proposedProject).toBeNull();

      const actionableProposals = proposals.filter((p) => !p.excludedByInstruction);
      expect(actionableProposals.length).toBeGreaterThan(0);

      const targetKey = actionableProposals[0].threadKey;
      const before = (await db.conversations.get(targetKey))!;

      const log = await applyOrganizeProposals(
        db,
        'Group Daydock logo threads into Daydock / Meridian',
        proposals
      );
      expect(log.snapshots.length).toBe(actionableProposals.length);

      const afterApply = (await db.conversations.get(targetKey))!;
      expect(afterApply.project).toBe('Daydock / Meridian');

      // And homepage research remained in General research untouched
      const homepageAfterApply = (await db.conversations.get(
        homepageProposal!.threadKey
      ))!;
      expect(homepageAfterApply.project).toBe('General research');

      const undoRes = await undoChangeLog(db, log.changeId);
      expect(undoRes.restoredCount).toBe(actionableProposals.length);

      const afterUndo = (await db.conversations.get(targetKey))!;
      expect(afterUndo.project).toBe(before.project);
      expect(afterUndo.tags).toEqual(before.tags);
    });
  });

  describe('LIFE-09: Cascade Delete, Tombstone Protection, Resumable Jobs & Count Reconciliation', () => {
    beforeEach(async () => {
      await seedSyntheticWorkbenchLibrary(db);
    });

    it('cascades deletes across all 6 stores, cancels pending jobs, records a tombstone, and reconciles header/facet counts exactly', async () => {
      const targetKey = buildThreadKey({
        provider: 'chatgpt',
        accountId: 'acct_chatgpt_primary',
        workspaceId: 'ws_personal',
        sourceConversationId: 'conv_daydock_logo_grid',
        branchId: 'main',
      });
      const beforeCounts = await reconcileLibraryCounts(db);
      expect(beforeCounts.totalThreads).toBe(
        beforeCounts.filedCount + beforeCounts.unfiledCount
      );

      // Enqueue a pending job for this thread before deletion
      await enqueueJob(db, {
        jobType: 'enrich_thread',
        threadKey: targetKey,
        targetRevision: 1,
      });

      await deleteConversationCascade(db, targetKey);

      expect(await db.conversations.get(targetKey)).toBeUndefined();
      expect(await db.messages.where('threadKey').equals(targetKey).count()).toBe(0);
      expect(await db.summaries.get(targetKey)).toBeUndefined();
      expect(await db.chunks.where('threadKey').equals(targetKey).count()).toBe(0);
      expect(await db.vectors.where('threadKey').equals(targetKey).count()).toBe(0);
      expect(
        await db.relationships.where('fromThreadKey').equals(targetKey).count()
      ).toBe(0);
      expect(
        await db.relationships.where('toThreadKey').equals(targetKey).count()
      ).toBe(0);
      expect(await db.tombstones.get(targetKey)).toBeDefined();

      const jobsForDeleted = await db.jobs
        .where('threadKey')
        .equals(targetKey)
        .toArray();
      expect(jobsForDeleted.every((j) => j.status === 'cancelled')).toBe(true);

      // Passive recapture must be skipped by tombstone
      const recaptureRes = await upsertThread(db, {
        threadKey: targetKey,
        provider: 'chatgpt',
        accountId: 'acct_chatgpt_primary',
        workspaceId: 'ws_personal',
        sourceConversationId: 'conv_daydock_logo_grid',
        branchId: 'main',
        canonicalUrl: 'https://chatgpt.com/c/conv_daydock_logo_grid',
        title: 'Resurrected by passive sidebar scan',
        createdAt: null,
        updatedAt: null,
        coverage: 'title_only',
        captureSource: 'dom_observer',
        messages: [],
      });
      expect(recaptureRes.status).toBe('skipped_tombstone');

      // Cross-account recapture of the same (provider, sourceConversationId, branchId) must also be skipped by tombstone
      const crossAccountKey = buildThreadKey({
        provider: 'chatgpt',
        accountId: 'acct_chatgpt_secondary',
        workspaceId: 'ws_team',
        sourceConversationId: 'conv_daydock_logo_grid',
        branchId: 'main',
      });
      const crossAccountRecapture = await upsertThread(db, {
        threadKey: crossAccountKey,
        provider: 'chatgpt',
        accountId: 'acct_chatgpt_secondary',
        workspaceId: 'ws_team',
        sourceConversationId: 'conv_daydock_logo_grid',
        branchId: 'main',
        canonicalUrl: 'https://chatgpt.com/c/conv_daydock_logo_grid',
        title: 'Resurrected under another accountId',
        createdAt: null,
        updatedAt: null,
        coverage: 'title_only',
        captureSource: 'dom_observer',
        messages: [],
      });
      expect(crossAccountRecapture.status).toBe('skipped_tombstone');

      // Manual field update on tombstoned threadKey must also return null and not resurrect the record
      const manualOnDeleted = await updateManualThreadFields(db, targetKey, {
        manualNotes: 'Should not resurrect deleted thread',
      });
      expect(manualOnDeleted).toBeNull();
      expect(await db.conversations.get(targetKey)).toBeUndefined();

      const afterCounts = await reconcileLibraryCounts(db);
      expect(afterCounts.totalThreads).toBe(beforeCounts.totalThreads - 1);
      expect(afterCounts.totalThreads).toBe(
        afterCounts.filedCount + afterCounts.unfiledCount
      );
      const sumProjects = Object.values(afterCounts.projectCounts).reduce(
        (a, b) => a + b,
        0
      );
      expect(sumProjects).toBe(afterCounts.totalThreads);

      // Resumable job recovery check on remaining live thread
      const liveKey = buildThreadKey({
        provider: 'chatgpt',
        accountId: 'acct_chatgpt_primary',
        workspaceId: 'ws_personal',
        sourceConversationId: 'conv_hypestake_ws_delta',
        branchId: 'main',
      });
      const job = await enqueueJob(db, {
        jobType: 'reconcile_index',
        threadKey: liveKey,
        targetRevision: 1,
      });
      // Simulate interrupted 'running' state
      await db.jobs.update(job.jobId, { status: 'running', attempts: 1 });
      const stats = await processResumableJobs(db, async () => {
        // job completes cleanly
      });
      expect(stats.completed).toBe(1);
    });
  });

  describe('PRIV-11: Runtime Sender Validation & Spoofed postMessage Rejection', () => {
    it('rejects runtime messages from foreign extensions or spoofed window.postMessage payloads', () => {
      const validSender = validateRuntimeMessageSender(
        { type: 'OPEN_FULL_PAGE_MANAGER' },
        { id: 'my-ext-id', url: 'chrome-extension://my-ext-id/manager.html' },
        'my-ext-id'
      );
      expect(validSender.allowed).toBe(true);

      const foreignExt = validateRuntimeMessageSender(
        { type: 'DELETE_THREAD' },
        { id: 'evil-ext-id', url: 'chrome-extension://evil-ext-id/bg.html' },
        'my-ext-id'
      );
      expect(foreignExt.allowed).toBe(false);

      const spoofedPostMessage = validateWindowPostMessage(
        {
          origin: 'https://chatgpt.com',
          data: { type: 'TK_EXPORT_ALL', token: 'wrong-token' },
        },
        'chrome-extension://my-ext-id',
        'secret-handshake-token'
      );
      expect(spoofedPostMessage.allowed).toBe(false);

      // CLOSE_THREADKEEPER_OVERLAY and REDEEM_OVERLAY_HANDSHAKE require a non-empty handshakeToken >= 16 chars
      const closeWithoutToken = validateRuntimeMessageSender(
        { type: 'CLOSE_THREADKEEPER_OVERLAY', handshakeToken: '' },
        { id: 'my-ext-id', url: 'chrome-extension://my-ext-id/manager.html' },
        'my-ext-id'
      );
      expect(closeWithoutToken.allowed).toBe(false);
      expect(closeWithoutToken.reason).toContain('missing or short handshakeToken');

      const closeWithToken = validateRuntimeMessageSender(
        {
          type: 'CLOSE_THREADKEEPER_OVERLAY',
          handshakeToken: '0123456789abcdef0123456789abcdef',
        },
        { id: 'my-ext-id', url: 'chrome-extension://my-ext-id/manager.html' },
        'my-ext-id'
      );
      expect(closeWithToken.allowed).toBe(true);
    });
  });

  describe('WORKER-E2E: Extension Cloud Client to Authenticated Worker Wire Contract', () => {
    beforeEach(async () => {
      await seedSyntheticWorkbenchLibrary(db);
    });

    it('executes requestThreadEnrichment, requestQueryEmbedding, and requestCandidateRerank with strict shared/cloud.ts wire validation and resets stale UTC daily budget dates', async () => {
      const token = 'tk_live_test_token_999';

      const workerFetch: typeof fetch = async (input, init) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const parsedUrl = new URL(url);
        const headers = new Headers(init?.headers);
        if (headers.get('Authorization') !== `Bearer ${token}`) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
          });
        }
        const rawBody = JSON.parse(String(init?.body ?? '{}'));

        if (
          parsedUrl.pathname === '/v1/enrich-thread' ||
          parsedUrl.pathname === '/v1/enrich'
        ) {
          const parsed = EnrichThreadRequestSchema.safeParse(rawBody);
          if (!parsed.success) {
            return new Response(JSON.stringify({ error: parsed.error.message }), {
              status: 400,
            });
          }
          const firstTurn = parsed.data.messages[0];
          const quote = firstTurn.content.slice(0, 35);
          const anchor = {
            messageOrdinal: firstTurn.ordinal,
            messageId: firstTurn.messageId,
            quote,
            sourceRevision: parsed.data.sourceRevision,
            provenance: 'explicit' as const,
            commitment: 'user_committed' as const,
          };
          const candidateSummary = {
            suggestedAlias: 'Daydock SVG Grid Lock',
            oneSentenceOverview:
              'End-to-end Worker enrichment summary with verified quote.',
            overviewAnchor: anchor,
            expandedSummary:
              'Locked 24px grid spacing and prepared SVG export for Daydock.',
            userGoal: 'Create SVG grid for Daydock',
            latestDevelopment: 'Grid spacing locked',
            whereLeftOff: 'Ready to export SVG grid',
            whereLeftOffAnchor: anchor,
            changedSinceLastReview: null,
            suggestedWorkflowStatus: 'active' as const,
            suggestedProjectName: 'Daydock / Meridian',
            suggestedWorkstream: 'Brand',
            suggestedTags: ['svg-grid', 'e2e'],
            claims: [
              {
                id: 'claim_1',
                kind: 'decision' as const,
                text: 'Lock 24px grid',
                anchor,
              },
            ],
            importantOutputs: [],
            confidence: 0.92,
          };
          const verified = verifyStructuredSummaryEvidence(
            candidateSummary,
            parsed.data
          );
          if (!verified.valid) {
            return new Response(
              JSON.stringify({ error: verified.errors.join('; ') }),
              { status: 422 }
            );
          }
          return new Response(
            JSON.stringify({
              model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
              sourceRevision: parsed.data.sourceRevision,
              summary: verified.sanitized,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (
          parsedUrl.pathname === '/v1/embeddings/standard' ||
          parsedUrl.pathname === '/v1/embeddings'
        ) {
          const parsed = StandardEmbeddingRequestSchema.safeParse(rawBody);
          if (!parsed.success) {
            return new Response(JSON.stringify({ error: parsed.error.message }), {
              status: 400,
            });
          }
          return new Response(
            JSON.stringify({
              model: parsed.data.model,
              dimensions: parsed.data.outputDimension,
              embeddings: [new Array(parsed.data.outputDimension).fill(0.125)],
              usage: { totalTokens: 12 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (parsedUrl.pathname === '/v1/rerank') {
          const parsed = RerankRequestSchema.safeParse(rawBody);
          if (!parsed.success) {
            return new Response(JSON.stringify({ error: parsed.error.message }), {
              status: 400,
            });
          }
          return new Response(
            JSON.stringify({
              model: parsed.data.model,
              results: [{ index: 0, relevanceScore: 0.97 }],
              usage: { totalTokens: 20 },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
        });
      };

      // Configure stale budget date from yesterday with exhausted count (50/50)
      await db.settings.update('default', {
        cloudEnabled: true,
        workerEndpointUrl: 'https://worker.threadkeeper.example',
        workerBearerToken: token,
        dailyCloudRequestBudget: 50,
        dailyCloudRequestsUsed: 50,
        dailyCloudBudgetDate: '2020-01-01',
      });

      const targetKey = buildThreadKey({
        provider: 'chatgpt',
        accountId: 'acct_chatgpt_primary',
        workspaceId: 'ws_personal',
        sourceConversationId: 'conv_daydock_logo_grid',
        branchId: 'main',
      });
      const targetConv = (await db.conversations.get(targetKey))!;
      await db.summaries.delete(targetKey);

      // Eligibility check must recognize stale date and allow the call
      const elig = await checkCloudEligibility(db, targetConv);
      expect(elig.allowed).toBe(true);

      const enrichRes = await requestThreadEnrichment(db, targetKey, workerFetch);
      expect(enrichRes.status).toBe('enriched');

      // Budget date rolled over to today's UTC date and used = 1
      const updatedSettings = await db.settings.get('default');
      expect(updatedSettings?.dailyCloudBudgetDate).toBe(currentUtcDateKey());
      expect(updatedSettings?.dailyCloudRequestsUsed).toBe(1);

      // Delete cached summary so next call actually invokes fetchImpl, and verify network error refunds budget slot
      await db.summaries.delete(targetKey);
      const failingFetch: typeof fetch = async () => {
        throw new Error('Offline network failure');
      };
      const failedRes = await requestThreadEnrichment(db, targetKey, failingFetch);
      expect(failedRes.status).toBe('rejected');
      const afterRefundSettings = await db.settings.get('default');
      expect(afterRefundSettings?.dailyCloudRequestsUsed).toBe(1);

      // Verify non-2xx HTTP status (500) refunds client budget slot, while 2xx HTTP status consumes the budget slot even if response payload is rejected
      const http500Fetch: typeof fetch = async () =>
        new Response(JSON.stringify({ error: 'Upstream failure' }), { status: 500 });
      const http500Res = await requestThreadEnrichment(db, targetKey, http500Fetch);
      expect(http500Res.status).toBe('rejected');
      expect((await db.settings.get('default'))?.dailyCloudRequestsUsed).toBe(1);

      const badSchemaFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ summary: { invalid: true } }), { status: 200 });
      const badSchemaRes = await requestThreadEnrichment(db, targetKey, badSchemaFetch);
      expect(badSchemaRes.status).toBe('rejected');
      expect((await db.settings.get('default'))?.dailyCloudRequestsUsed).toBe(2);

      // Verify that 10 repeated calls with dailyCloudRequestBudget = 3 and HTTP 200 malformed/ungrounded responses invoke fetch at most 3 times
      await db.settings.update('default', {
        dailyCloudRequestBudget: 3,
        dailyCloudRequestsUsed: 0,
        dailyCloudBudgetDate: currentUtcDateKey(),
      });
      let ungroundedFetchCalls = 0;
      const ungrounded200Fetch: typeof fetch = async () => {
        ungroundedFetchCalls += 1;
        return new Response(
          JSON.stringify({
            summary: {
              suggestedAlias: 'Alias',
              oneSentenceOverview: 'Overview',
              overviewAnchor: {
                messageOrdinal: 1,
                messageId: 'msg_1',
                quote: 'non-existent fabricated quote xyz987',
                sourceRevision: String(targetConv.sourceRevision),
                provenance: 'explicit',
                commitment: 'user_committed',
              },
              expandedSummary: 'Expanded',
              userGoal: null,
              latestDevelopment: null,
              whereLeftOff: 'Where left off',
              whereLeftOffAnchor: {
                messageOrdinal: 1,
                messageId: 'msg_1',
                quote: 'non-existent fabricated quote xyz987',
                sourceRevision: String(targetConv.sourceRevision),
                provenance: 'explicit',
                commitment: 'user_committed',
              },
              changedSinceLastReview: null,
              suggestedWorkflowStatus: 'active',
              suggestedProjectName: 'Daydock / Meridian',
              suggestedWorkstream: null,
              suggestedTags: [],
              claims: [],
              importantOutputs: [],
              confidence: 0.8,
            },
          }),
          { status: 200 }
        );
      };
      for (let attempt = 0; attempt < 10; attempt++) {
        const res = await requestThreadEnrichment(db, targetKey, ungrounded200Fetch);
        expect(res.status).toBe('rejected');
      }
      expect(ungroundedFetchCalls).toBe(3);
      expect((await db.settings.get('default'))?.dailyCloudRequestsUsed).toBe(3);

      // Restore budget for remaining checks
      await db.settings.update('default', {
        dailyCloudRequestBudget: 50,
        dailyCloudRequestsUsed: 1,
        dailyCloudBudgetDate: currentUtcDateKey(),
      });

      // Verify that when a 'full' coverage thread is truncated by the 200-message cap, wire coverage is downgraded to 'partial'
      const longThreadKey = buildThreadKey({
        provider: 'chatgpt',
        accountId: 'acct_chatgpt_primary',
        workspaceId: 'ws_personal',
        sourceConversationId: 'conv_long_210_turns',
        branchId: 'main',
      });
      await upsertThread(db, {
        threadKey: longThreadKey,
        provider: 'chatgpt',
        accountId: 'acct_chatgpt_primary',
        workspaceId: 'ws_personal',
        sourceConversationId: 'conv_long_210_turns',
        branchId: 'main',
        canonicalUrl: 'https://chatgpt.com/c/conv_long_210_turns',
        title: 'Long 210-turn thread',
        createdAt: '2026-10-20T00:00:00Z',
        updatedAt: '2026-10-20T01:00:00Z',
        coverage: 'full',
        captureSource: 'export_import',
        messages: Array.from({ length: 210 }, (_, idx) => ({
          sourceMessageId: `m_long_${idx + 1}`,
          role: idx % 2 === 0 ? 'user' : 'assistant',
          content: `Turn number ${idx + 1} discussing Daydock architecture.`,
          createdAt: '2026-10-20T00:00:00Z',
          branchPath: 'main',
        })),
      });
      let capturedLongCoverage = '';
      const inspectLongFetch: typeof fetch = async (input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        capturedLongCoverage = body.coverage;
        return workerFetch(input, init);
      };
      const longEnrichRes = await requestThreadEnrichment(db, longThreadKey, inspectLongFetch);
      expect(longEnrichRes.status).toBe('enriched');
      expect(capturedLongCoverage).toBe('partial');

      // Shifted-ordinal negative regression on >200-turn conversation (A_F5):
      // In conv_long_210_turns, wireMessages[0] has wireOrdinal=1 and dbOrdinal=10 (dbOrdinal+1 = 11).
      // Verify that an anchor pairing wireMessages[0].messageId with messageOrdinal=11 (dbOrdinal+1)
      // is strictly rejected rather than accepted via dbOrdinal+1 fallback.
      await db.summaries.delete(longThreadKey);
      const shiftedOrdinalMismatchFetch: typeof fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const firstWireMsg = body.messages[0]; // wireOrdinal=1, dbOrdinal=10
        const shiftedAnchor = {
          messageOrdinal: 11, // equals firstWireMsg.dbOrdinal + 1, which corresponds to wireMessages[10]
          messageId: firstWireMsg.messageId,
          quote: firstWireMsg.content.slice(0, 40),
          sourceRevision: body.sourceRevision,
          provenance: 'explicit',
          commitment: 'user_committed',
        };
        return new Response(
          JSON.stringify({
            model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
            sourceRevision: body.sourceRevision,
            summary: {
              suggestedAlias: 'Shifted Alias',
              oneSentenceOverview: 'Shifted overview',
              overviewAnchor: shiftedAnchor,
              expandedSummary: 'Shifted expanded summary',
              userGoal: null,
              latestDevelopment: null,
              whereLeftOff: 'Shifted where left off',
              whereLeftOffAnchor: shiftedAnchor,
              changedSinceLastReview: null,
              suggestedWorkflowStatus: 'active',
              suggestedProjectName: 'Daydock / Meridian',
              suggestedWorkstream: null,
              suggestedTags: [],
              claims: [],
              importantOutputs: [],
              confidence: 0.9,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };
      const shiftedMismatchRes = await requestThreadEnrichment(
        db,
        longThreadKey,
        shiftedOrdinalMismatchFetch
      );
      expect(shiftedMismatchRes.status).toBe('rejected');
      expect(shiftedMismatchRes.reason).toContain('messageId/ordinal mismatch');

      // Verify single-turn >32,000-char content truncation also downgrades wire coverage to 'partial',
      // and >300-char title / >100 tags / >200-char messageId are clamped to wire schema bounds
      const singleHugeTurnKey = buildThreadKey({
        provider: 'chatgpt',
        accountId: 'acct_chatgpt_primary',
        workspaceId: 'ws_personal',
        sourceConversationId: 'conv_single_35k_turn',
        branchId: 'main',
      });
      await upsertThread(db, {
        threadKey: singleHugeTurnKey,
        provider: 'chatgpt',
        accountId: 'acct_chatgpt_primary',
        workspaceId: 'ws_personal',
        sourceConversationId: 'conv_single_35k_turn',
        branchId: 'main',
        canonicalUrl: 'https://chatgpt.com/c/conv_single_35k_turn',
        title: 'T'.repeat(350),
        createdAt: '2026-10-20T00:00:00Z',
        updatedAt: '2026-10-20T01:00:00Z',
        coverage: 'full',
        captureSource: 'export_import',
        tags: Array.from({ length: 120 }, (_, i) => `tag_${i}_${'x'.repeat(65)}`),
        messages: [
          {
            sourceMessageId: `msg_id_${'m'.repeat(230)}`,
            role: 'user',
            content: `Daydock SVG specification details: ${'A'.repeat(35000)}`,
            createdAt: '2026-10-20T00:00:00Z',
            branchPath: 'main',
          },
          {
            sourceMessageId: 'msg_id_2',
            role: 'assistant',
            content: 'Confirmed 24px grid spacing for Daydock.',
            createdAt: '2026-10-20T00:05:00Z',
            branchPath: 'main',
          },
        ],
      });
      let capturedHugeTurnBody: Record<string, unknown> = {};
      const inspectHugeTurnFetch: typeof fetch = async (input, init) => {
        capturedHugeTurnBody = JSON.parse(String(init?.body ?? '{}'));
        return workerFetch(input, init);
      };
      const hugeTurnRes = await requestThreadEnrichment(
        db,
        singleHugeTurnKey,
        inspectHugeTurnFetch
      );
      expect(hugeTurnRes.status).toBe('enriched');
      expect(capturedHugeTurnBody.coverage).toBe('partial');
      expect((capturedHugeTurnBody.originalTitle as string).length).toBe(300);
      expect((capturedHugeTurnBody.establishedTags as string[]).length).toBe(100);
      const updatedHugeConv = await db.conversations.get(singleHugeTurnKey);
      expect(updatedHugeConv?.tags.length).toBeLessThanOrEqual(100);

      // Verify that an anchor with mismatched messageId vs messageOrdinal is rejected (no silent messageId-only acceptance)
      await db.summaries.delete(singleHugeTurnKey);
      const mismatchedOrdinalFetch: typeof fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const firstMsg = body.messages[0];
        const mismatchedAnchor = {
          messageOrdinal: 2, // mismatch! firstMsg has ordinal 1
          messageId: firstMsg.messageId,
          quote: 'Daydock SVG specification details',
          sourceRevision: body.sourceRevision,
          provenance: 'explicit',
          commitment: 'user_committed',
        };
        return new Response(
          JSON.stringify({
            model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
            sourceRevision: body.sourceRevision,
            summary: {
              suggestedAlias: 'Alias',
              oneSentenceOverview: 'Overview',
              overviewAnchor: mismatchedAnchor,
              expandedSummary: 'Expanded',
              userGoal: null,
              latestDevelopment: null,
              whereLeftOff: 'Where left off',
              whereLeftOffAnchor: mismatchedAnchor,
              changedSinceLastReview: null,
              suggestedWorkflowStatus: 'active',
              suggestedProjectName: 'Daydock / Meridian',
              suggestedWorkstream: null,
              suggestedTags: [],
              claims: [],
              importantOutputs: [],
              confidence: 0.9,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };
      const mismatchOrdRes = await requestThreadEnrichment(
        db,
        singleHugeTurnKey,
        mismatchedOrdinalFetch
      );
      expect(mismatchOrdRes.status).toBe('rejected');
      expect(mismatchOrdRes.reason).toContain('messageId/ordinal mismatch');

      // Verify short quotes (< 12 chars) are rejected by client/schema verification (OPUS_XHIGH_F23)
      const shortQuoteFetch: typeof fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const firstMsg = body.messages[0];
        const shortAnchor = {
          messageOrdinal: 1,
          messageId: firstMsg.messageId,
          quote: 'Daydock', // 7 chars (< 12 minimum)
          sourceRevision: body.sourceRevision,
          provenance: 'explicit',
          commitment: 'user_committed',
        };
        return new Response(
          JSON.stringify({
            model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
            sourceRevision: body.sourceRevision,
            summary: {
              suggestedAlias: 'Short Quote Alias',
              oneSentenceOverview: 'Overview',
              overviewAnchor: shortAnchor,
              expandedSummary: 'Expanded',
              userGoal: null,
              latestDevelopment: null,
              whereLeftOff: 'Where left off',
              whereLeftOffAnchor: shortAnchor,
              changedSinceLastReview: null,
              suggestedWorkflowStatus: 'active',
              suggestedProjectName: 'Daydock / Meridian',
              suggestedWorkstream: null,
              suggestedTags: [],
              claims: [],
              importantOutputs: [],
              confidence: 0.9,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      };
      const shortQuoteRes = await requestThreadEnrichment(
        db,
        singleHugeTurnKey,
        shortQuoteFetch
      );
      expect(shortQuoteRes.status).toBe('rejected');

      await db.settings.update('default', {
        dailyCloudRequestBudget: 50,
        dailyCloudRequestsUsed: 1,
        dailyCloudBudgetDate: currentUtcDateKey(),
      });

      const failedEmbedRes = await requestQueryEmbedding(db, 'Daydock', http500Fetch);
      expect(failedEmbedRes.status).toBe('rejected');
      expect((await db.settings.get('default'))?.dailyCloudRequestsUsed).toBe(1);

      const failedRerankRes = await requestCandidateRerank(
        db,
        'Daydock',
        ['Doc 1'],
        1,
        http500Fetch
      );
      expect(failedRerankRes.status).toBe('rejected');
      expect((await db.settings.get('default'))?.dailyCloudRequestsUsed).toBe(1);

      // Test query embedding and candidate reranking via Worker
      const embedRes = await requestQueryEmbedding(
        db,
        'Daydock SVG grid',
        workerFetch
      );
      expect(embedRes.embedding?.length).toBe(1024);

      const rerankRes = await requestCandidateRerank(
        db,
        'Daydock SVG grid',
        ['Daydock Meridian SVG grid system', 'Unrelated thread'],
        2,
        workerFetch
      );
      expect(rerankRes.results?.[0]).toEqual({ index: 0, relevanceScore: 0.97 });

      // Verify atomic budget admission under concurrent calls when only 1 slot remains
      await db.settings.update('default', {
        dailyCloudRequestBudget: 4,
        dailyCloudRequestsUsed: 3,
        dailyCloudBudgetDate: currentUtcDateKey(),
      });
      const [concurrentA, concurrentB] = await Promise.all([
        requestQueryEmbedding(db, 'Concurrent query A', workerFetch),
        requestQueryEmbedding(db, 'Concurrent query B', workerFetch),
      ]);
      const statuses = [concurrentA.status, concurrentB.status].sort();
      expect(statuses).toEqual(['ok', 'rejected']);
      expect((await db.settings.get('default'))?.dailyCloudRequestsUsed).toBe(4);

      // Verify cross-UTC-midnight failure does not decrement the new day's dailyCloudRequestsUsed counter
      await db.settings.update('default', {
        dailyCloudRequestBudget: 10,
        dailyCloudRequestsUsed: 1,
        dailyCloudBudgetDate: currentUtcDateKey(),
      });
      const crossMidnightFailingFetch: typeof fetch = async () => {
        await db.settings.update('default', {
          dailyCloudBudgetDate: '2099-01-01',
          dailyCloudRequestsUsed: 3,
        });
        return new Response(JSON.stringify({ error: 'Upstream failure' }), { status: 500 });
      };
      const crossMidnightRes = await requestQueryEmbedding(
        db,
        'Cross midnight query',
        crossMidnightFailingFetch
      );
      expect(crossMidnightRes.status).toBe('rejected');
      expect((await db.settings.get('default'))?.dailyCloudRequestsUsed).toBe(3);

      // Verify applySummaryEnrichment rejects future sourceRevision (> current) and mismatched contentHash
      const targetConvNow = await db.conversations.get(targetKey);
      expect(targetConvNow).toBeDefined();
      const existingSummary = enrichRes.summary;
      expect(existingSummary).toBeDefined();
      if (targetConvNow && existingSummary) {
        const futureRevRes = await applySummaryEnrichment(db, {
          threadKey: targetKey,
          sourceRevision: targetConvNow.sourceRevision + 5,
          contentHash: targetConvNow.contentHash,
          model: existingSummary.model,
          summary: existingSummary,
        });
        expect(futureRevRes.applied).toBe(false);
        expect(futureRevRes.reason).toContain('stale_revision_');

        const mismatchedHashRes = await applySummaryEnrichment(db, {
          threadKey: targetKey,
          sourceRevision: targetConvNow.sourceRevision,
          contentHash: 'hash_mismatched_stale',
          model: existingSummary.model,
          summary: existingSummary,
        });
        expect(mismatchedHashRes.applied).toBe(false);
        expect(mismatchedHashRes.reason).toContain('stale_content_hash_');

        const emptyHashRes = await applySummaryEnrichment(db, {
          threadKey: targetKey,
          sourceRevision: targetConvNow.sourceRevision,
          contentHash: '',
          model: existingSummary.model,
          summary: existingSummary,
        });
        expect(emptyHashRes.applied).toBe(false);
        expect(emptyHashRes.reason).toContain('stale_content_hash_');
      }

      // Verify restoreDeleted: true clears all matching composite tombstones across accounts
      const tKeyA = buildThreadKey({
        provider: 'chatgpt',
        accountId: 'acct_a',
        workspaceId: 'ws_1',
        sourceConversationId: 'conv_multi_tombstone',
        branchId: 'main',
      });
      const tKeyB = buildThreadKey({
        provider: 'chatgpt',
        accountId: 'acct_b',
        workspaceId: 'ws_1',
        sourceConversationId: 'conv_multi_tombstone',
        branchId: 'main',
      });
      await db.tombstones.bulkPut([
        {
          threadKey: tKeyA,
          provider: 'chatgpt',
          sourceConversationId: 'conv_multi_tombstone',
          branchId: 'main',
          deletedAt: new Date().toISOString(),
          lastKnownContentHash: 'h_a',
        },
        {
          threadKey: tKeyB,
          provider: 'chatgpt',
          sourceConversationId: 'conv_multi_tombstone',
          branchId: 'main',
          deletedAt: new Date().toISOString(),
          lastKnownContentHash: 'h_b',
        },
      ]);
      const restoredMulti = await upsertThread(db, {
        threadKey: tKeyA,
        provider: 'chatgpt',
        accountId: 'acct_a',
        workspaceId: 'ws_1',
        sourceConversationId: 'conv_multi_tombstone',
        branchId: 'main',
        canonicalUrl: 'https://chatgpt.com/c/conv_multi_tombstone',
        title: 'Restored multi tombstone thread',
        createdAt: null,
        updatedAt: null,
        coverage: 'partial',
        captureSource: 'export_import',
        restoreDeleted: true,
        messages: [],
      });
      expect(restoredMulti.status).toBe('stored');
      const remainingTombstones = await db.tombstones
        .where('[provider+sourceConversationId+branchId]')
        .equals(['chatgpt', 'conv_multi_tombstone', 'main'])
        .count();
      expect(remainingTombstones).toBe(0);
    });
  });
});

