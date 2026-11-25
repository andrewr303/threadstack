import {
  buildThreadKey,
  computeDeterministicHash,
  type ConversationRecord,
  type MessageRecord,
  type RelationshipRecord,
} from './schema.js';
import {
  upsertThread,
  applySummaryEnrichment,
  ensureStarterCollectionsAndSettings,
  type ThreadStackDB,
} from './db.js';
import type { ChatGPTExportConversation } from './adapters.js';
import type { ProviderId } from './providers.js';
import { processThreadsLocally } from './pipeline.js';
import type { AccountRecord, AgentState } from './workspace/types.js';
import { primaryAccountId } from './workspace/realms.js';

export async function seedSyntheticWorkbenchLibrary(
  db: ThreadStackDB,
  options?: { force?: boolean }
): Promise<void> {
  await ensureStarterCollectionsAndSettings(db);

  const accountId = 'acct_chatgpt_primary';
  const claudeAccount = 'acct_claude_primary';
  const workspaceId = 'ws_personal';

  // 1. Daydock / Meridian logo geometry & SVG grid (main branch)
  const kDaydockLogo1 = buildThreadKey({
    provider: 'chatgpt',
    accountId,
    workspaceId,
    sourceConversationId: 'conv_daydock_logo_grid',
    branchId: 'main',
  });
  const kDaydockLogo1Branch2 = buildThreadKey({
    provider: 'chatgpt',
    accountId,
    workspaceId,
    sourceConversationId: 'conv_daydock_logo_grid',
    branchId: 'branch_2',
  });

  if (!options?.force) {
    const [existingMain, existingBranch2, tombstoneCount] = await Promise.all([
      db.conversations.get(kDaydockLogo1),
      db.conversations.get(kDaydockLogo1Branch2),
      db.tombstones.count(),
    ]);
    if (existingMain || existingBranch2 || tombstoneCount > 0) return;
  }

  await upsertThread(db, {
    threadKey: kDaydockLogo1,
    provider: 'chatgpt',
    accountId,
    workspaceId,
    sourceConversationId: 'conv_daydock_logo_grid',
    branchId: 'main',
    parentBranchId: null,
    siblingBranchIds: ['branch_2'],
    canonicalUrl: 'https://chatgpt.com/c/conv_daydock_logo_grid',
    title: 'Daydock / Meridian logo geometry & SVG grid',
    createdAt: '2026-10-18T14:10:00.000Z',
    updatedAt: '2026-10-24T19:42:00.000Z',
    coverage: 'full',
    captureSource: 'export_import',
    project: 'Daydock / Meridian',
    categoryLocked: false,
    tags: ['logo', 'svg', 'branding'],
    workflowState: 'active',
    pinned: true,
    messages: [
      {
        sourceMessageId: 'dd1_m0',
        role: 'user',
        content:
          'We need to lock the Daydock / Meridian mark geometry before exporting the SVG icon set. Let us use a 24x24 optical grid with 1.75px stroke weight.',
        createdAt: '2026-10-18T14:10:00.000Z',
      },
      {
        sourceMessageId: 'dd1_m1',
        role: 'assistant',
        content:
          'A 24x24 optical grid with 1.75px stroke weight aligns cleanly with 16px and 32px toolbar rendering. I recommend a 14-degree meridian tilt on the inner aperture.',
        createdAt: '2026-10-18T14:11:15.000Z',
      },
      {
        sourceMessageId: 'dd1_m2',
        role: 'user',
        content:
          'Approved on the 14-degree meridian tilt. Next step: export the monochrome SVG wordmark and test at 16px favicon scale. Should we also generate a high-contrast dark variant?',
        createdAt: '2026-10-24T19:40:00.000Z',
      },
      {
        sourceMessageId: 'dd1_m3',
        role: 'assistant',
        content:
          'Here is the `daydock-meridian-mark.svg` specification using `#1F6F6B` mineral teal and `#161514` warm ink. For dark surfaces we should pair `#5FB8B0` with `#F2EFE9` bone.',
        createdAt: '2026-10-24T19:42:00.000Z',
      },
    ],
  });

  const convDd1 = await db.conversations.get(kDaydockLogo1);
  if (convDd1) {
    await applySummaryEnrichment(db, {
      threadKey: kDaydockLogo1,
      sourceRevision: convDd1.sourceRevision,
      contentHash: convDd1.contentHash,
      model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
      summary: {
        whereYouLeftOff:
          'Locked the 24x24 optical grid (1.75px stroke) and 14-degree meridian tilt; ready to export the monochrome SVG wordmark and verify 16px rendering.',
        whereYouLeftOffMessageIndexes: [0, 2],
        currentStatus:
          'Active design handoff — SVG geometry finalized, dark-surface variant token check open.',
        currentStatusMessageIndexes: [2, 3],
        decisions: [
          {
            text: 'Use a 24x24 optical grid with 1.75px stroke weight for the Daydock / Meridian mark.',
            speaker: 'user_committed',
            messageIndexes: [0],
            evidenceQuote: 'use a 24x24 optical grid with 1.75px stroke weight',
          },
          {
            text: 'Adopt the 14-degree meridian tilt on the inner aperture.',
            speaker: 'user_committed',
            messageIndexes: [1, 2],
            evidenceQuote: 'Approved on the 14-degree meridian tilt',
          },
        ],
        openQuestions: [
          {
            text: 'Should we also generate a dedicated high-contrast dark variant for 16px favicons?',
            speaker: 'user_committed',
            messageIndexes: [2],
            evidenceQuote: 'Should we also generate a high-contrast dark variant?',
          },
        ],
        actionItems: [
          {
            text: 'Export the monochrome SVG wordmark and test at 16px favicon scale.',
            speaker: 'user_committed',
            messageIndexes: [2],
            evidenceQuote:
              'export the monochrome SVG wordmark and test at 16px favicon scale',
          },
        ],
        constraints: [
          {
            text: 'Maintain 1.75px stroke alignment across 16px and 32px sizes.',
            speaker: 'assistant_suggested',
            messageIndexes: [1],
            evidenceQuote: '24x24 optical grid with 1.75px stroke weight aligns cleanly',
          },
        ],
        entities: ['Daydock', 'Meridian', 'daydock-meridian-mark.svg'],
        artifactReferences: ['daydock-meridian-mark.svg'],
        suggestedProject: 'Daydock / Meridian',
        suggestedTags: ['logo', 'svg', 'branding'],
        confidence: 0.96,
      },
    });
  }

  // Sibling branch of Daydock logo grid
  await upsertThread(db, {
    threadKey: kDaydockLogo1Branch2,
    provider: 'chatgpt',
    accountId,
    workspaceId,
    sourceConversationId: 'conv_daydock_logo_grid',
    branchId: 'branch_2',
    parentBranchId: 'main',
    siblingBranchIds: ['main'],
    canonicalUrl: 'https://chatgpt.com/c/conv_daydock_logo_grid?branch=branch_2',
    title: 'Daydock / Meridian logo geometry & SVG grid (branch_2)',
    createdAt: '2026-10-18T14:10:00.000Z',
    updatedAt: '2026-10-19T09:15:00.000Z',
    coverage: 'full',
    captureSource: 'export_import',
    project: 'Daydock / Meridian',
    categoryLocked: false,
    tags: ['logo', 'brutalist-alt'],
    workflowState: 'paused',
    messages: [
      {
        sourceMessageId: 'dd1_m0',
        role: 'user',
        content:
          'We need to lock the Daydock / Meridian mark geometry before exporting the SVG icon set. Let us use a 24x24 optical grid with 1.75px stroke weight.',
        createdAt: '2026-10-18T14:10:00.000Z',
      },
      {
        sourceMessageId: 'dd1_b2_m1',
        role: 'user',
        content:
          'What if we tried a heavy 3px brutalist square frame instead of the meridian tilt?',
        createdAt: '2026-10-19T09:14:00.000Z',
      },
      {
        sourceMessageId: 'dd1_b2_m2',
        role: 'assistant',
        content:
          'A 3px square frame closes up at 16px sizes and loses the horizon metaphor.',
        createdAt: '2026-10-19T09:15:00.000Z',
      },
    ],
  });

  // 2. Second Daydock logo thread (currently Unfiled so NL Organize can group it!)
  const kDaydockLogo2 = buildThreadKey({
    provider: 'claude',
    accountId: claudeAccount,
    workspaceId,
    sourceConversationId: 'conv_daydock_logo_wordmark',
    branchId: 'main',
  });
  await upsertThread(db, {
    threadKey: kDaydockLogo2,
    provider: 'claude',
    accountId: claudeAccount,
    workspaceId,
    sourceConversationId: 'conv_daydock_logo_wordmark',
    branchId: 'main',
    canonicalUrl: 'https://claude.ai/chat/conv_daydock_logo_wordmark',
    title: 'Daydock logo wordmark kerning & optical lockup',
    createdAt: '2026-10-21T11:00:00.000Z',
    updatedAt: '2026-10-23T16:20:00.000Z',
    coverage: 'partial',
    captureSource: 'dom_observer',
    project: 'Unfiled / Uncertain',
    categoryLocked: false,
    tags: ['logo', 'typography'],
    workflowState: 'needs_review',
    latestDecisionText: 'Set wordmark tracking to -0.018em paired with Newsreader display headers.',
    latestDecisionMsgIndex: 1,
    latestDecisionSpeaker: 'user_committed',
    nextStepText: 'Compare optical spacing between Daydock mark and wordmark at 24px height.',
    nextStepMsgIndex: 1,
    nextStepSpeaker: 'user_committed',
    messages: [
      {
        sourceMessageId: 'dd2_m0',
        role: 'user',
        content:
          'Let us tune the Daydock logo wordmark kerning so the D-a-y pair does not feel loose next to the 24x24 mark.',
        createdAt: '2026-10-21T11:00:00.000Z',
      },
      {
        sourceMessageId: 'dd2_m1',
        role: 'user',
        content:
          'We will set wordmark tracking to -0.018em paired with Newsreader display headers, and next compare optical spacing between Daydock mark and wordmark at 24px height.',
        createdAt: '2026-10-23T16:20:00.000Z',
      },
    ],
  });

  // 3. Daydock homepage research thread (to verify "...but keep the homepage research separate"!)
  const kDaydockHomepage = buildThreadKey({
    provider: 'chatgpt',
    accountId,
    workspaceId,
    sourceConversationId: 'conv_daydock_homepage_research',
    branchId: 'main',
  });
  await upsertThread(db, {
    threadKey: kDaydockHomepage,
    provider: 'chatgpt',
    accountId,
    workspaceId,
    sourceConversationId: 'conv_daydock_homepage_research',
    branchId: 'main',
    canonicalUrl: 'https://chatgpt.com/c/conv_daydock_homepage_research',
    title: 'Daydock homepage research & pricing tier benchmarks',
    createdAt: '2026-10-20T08:30:00.000Z',
    updatedAt: '2026-10-22T15:05:00.000Z',
    coverage: 'full',
    captureSource: 'export_import',
    project: 'General research',
    categoryLocked: false,
    tags: ['homepage', 'research', 'pricing'],
    workflowState: 'active',
    latestDecisionText: 'Keep homepage research focused on calendar-first workflow benchmarks.',
    latestDecisionMsgIndex: 0,
    latestDecisionSpeaker: 'user_committed',
    nextStepText: 'Audit above-the-fold copy across 5 scheduling tools.',
    nextStepMsgIndex: 1,
    nextStepSpeaker: 'assistant_suggested',
    messages: [
      {
        sourceMessageId: 'dd_hp_m0',
        role: 'user',
        content:
          'Keep homepage research focused on calendar-first workflow benchmarks rather than visual logo explorations.',
        createdAt: '2026-10-20T08:30:00.000Z',
      },
      {
        sourceMessageId: 'dd_hp_m1',
        role: 'assistant',
        content:
          'Agreed. Let us audit above-the-fold copy across 5 scheduling tools and document conversion friction.',
        createdAt: '2026-10-22T15:05:00.000Z',
      },
    ],
  });

  // 4. HypeStake odds latency & WebSocket delta compression
  const kHypeStake = buildThreadKey({
    provider: 'chatgpt',
    accountId,
    workspaceId,
    sourceConversationId: 'conv_hypestake_ws_delta',
    branchId: 'main',
  });
  await upsertThread(db, {
    threadKey: kHypeStake,
    provider: 'chatgpt',
    accountId,
    workspaceId,
    sourceConversationId: 'conv_hypestake_ws_delta',
    branchId: 'main',
    canonicalUrl: 'https://chatgpt.com/c/conv_hypestake_ws_delta',
    title: 'HypeStake odds engine WebSocket delta compression',
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-24T12:15:00.000Z',
    coverage: 'full',
    captureSource: 'export_import',
    project: 'HypeStake',
    categoryLocked: true,
    tags: ['websocket', 'latency', 'code'],
    workflowState: 'active',
    latestDecisionText: 'Switch live odds feed to sequence-numbered msgpack diffs with 250ms coalesce window.',
    latestDecisionMsgIndex: 1,
    latestDecisionSpeaker: 'user_committed',
    nextStepText: 'Benchmark p99 fanout memory under 5,000 concurrent market ticks.',
    nextStepMsgIndex: 1,
    nextStepSpeaker: 'user_committed',
    messages: [
      {
        sourceMessageId: 'hs_m0',
        role: 'user',
        content:
          'Our HypeStake JSON tick payloads spike bandwidth during live NBA quarters. Should we use msgpack diffs?',
        createdAt: '2026-10-15T10:00:00.000Z',
      },
      {
        sourceMessageId: 'hs_m1',
        role: 'user',
        content:
          'We will switch live odds feed to sequence-numbered msgpack diffs with 250ms coalesce window, and benchmark p99 fanout memory under 5,000 concurrent market ticks.',
        createdAt: '2026-10-24T12:15:00.000Z',
      },
    ],
  });

  // 5. Velotic / FrameConcepts WebGPU timeline scrubber
  const kVelotic = buildThreadKey({
    provider: 'claude',
    accountId: claudeAccount,
    workspaceId,
    sourceConversationId: 'conv_velotic_webgpu_scrubber',
    branchId: 'main',
  });
  await upsertThread(db, {
    threadKey: kVelotic,
    provider: 'claude',
    accountId: claudeAccount,
    workspaceId,
    sourceConversationId: 'conv_velotic_webgpu_scrubber',
    branchId: 'main',
    canonicalUrl: 'https://claude.ai/chat/conv_velotic_webgpu_scrubber',
    title: 'Velotic / FrameConcepts WebGPU frame cache eviction',
    createdAt: '2026-10-17T18:20:00.000Z',
    updatedAt: '2026-10-23T21:00:00.000Z',
    coverage: 'partial',
    captureSource: 'dom_observer',
    project: 'Velotic / FrameConcepts',
    categoryLocked: false,
    tags: ['webgpu', 'shader', 'code'],
    workflowState: 'waiting',
    latestDecisionText: 'Cap GPU texture ring buffer at 384MB and pre-decode +/- 12 frames around playhead.',
    latestDecisionMsgIndex: 0,
    latestDecisionSpeaker: 'user_committed',
    nextStepText: 'Verify zero-copy VideoFrame import on Windows Chromium 130.',
    nextStepMsgIndex: 1,
    nextStepSpeaker: 'assistant_suggested',
    messages: [
      {
        sourceMessageId: 'vel_m0',
        role: 'user',
        content:
          'Cap GPU texture ring buffer at 384MB and pre-decode +/- 12 frames around playhead for FrameConcepts.',
        createdAt: '2026-10-17T18:20:00.000Z',
      },
      {
        sourceMessageId: 'vel_m1',
        role: 'assistant',
        content:
          'Next we should verify zero-copy VideoFrame import on Windows Chromium 130 using importExternalTexture.',
        createdAt: '2026-10-23T21:00:00.000Z',
      },
    ],
  });

  // 6. Personal local-only thread (cloudExcluded: true)
  const kPersonal = buildThreadKey({
    provider: 'chatgpt',
    accountId,
    workspaceId,
    sourceConversationId: 'conv_personal_q4_planning',
    branchId: 'main',
  });
  await upsertThread(db, {
    threadKey: kPersonal,
    provider: 'chatgpt',
    accountId,
    workspaceId,
    sourceConversationId: 'conv_personal_q4_planning',
    branchId: 'main',
    canonicalUrl: 'https://chatgpt.com/c/conv_personal_q4_planning',
    title: 'Personal Q4 travel & family cabin checklist',
    createdAt: '2026-10-12T09:00:00.000Z',
    updatedAt: '2026-10-19T11:30:00.000Z',
    coverage: 'full',
    captureSource: 'export_import',
    project: 'Personal',
    categoryLocked: true,
    tags: ['personal', 'travel'],
    workflowState: 'active',
    cloudExcluded: true,
    latestDecisionText: 'Book winter tires appointment before November 4.',
    latestDecisionMsgIndex: 0,
    latestDecisionSpeaker: 'user_committed',
    messages: [
      {
        sourceMessageId: 'pers_m0',
        role: 'user',
        content:
          'Private checklist: Book winter tires appointment before November 4 and pack emergency雪 chains.',
        createdAt: '2026-10-12T09:00:00.000Z',
      },
    ],
  });

  // Relationships between Daydock threads
  const relationships: RelationshipRecord[] = [
    {
      relationshipKey: `${kDaydockLogo2}->${kDaydockLogo1}:continues`,
      fromThreadKey: kDaydockLogo2,
      toThreadKey: kDaydockLogo1,
      relationType: 'continues',
      reason: 'Continues 24x24 Daydock mark geometry into wordmark kerning lockup',
      evidenceFromOrdinal: 0,
      evidenceToOrdinal: 2,
      confidence: 0.94,
      confirmedByUser: true,
      dismissedByUser: false,
    },
    {
      relationshipKey: `${kDaydockLogo1Branch2}->${kDaydockLogo1}:branches_from`,
      fromThreadKey: kDaydockLogo1Branch2,
      toThreadKey: kDaydockLogo1,
      relationType: 'branches_from',
      reason: 'Explored alternative 3px brutalist square frame from message m1',
      evidenceFromOrdinal: 1,
      evidenceToOrdinal: 0,
      confidence: 1.0,
      confirmedByUser: true,
      dismissedByUser: false,
    },
  ];
  await db.relationships.bulkPut(relationships);
}

export function generate652ChatGPTExportFixture(): ChatGPTExportConversation[] {
  const projects = [
    'HypeStake',
    'Velotic / FrameConcepts',
    'Daydock / Meridian',
    'General research',
    'Personal',
    'Unfiled / Uncertain',
  ];

  const items: ChatGPTExportConversation[] = [];
  const baseTs = 1728000000;

  for (let i = 1; i <= 652; i++) {
    const project = projects[i % projects.length];
    const convId = `chatgpt_652_${String(i).padStart(4, '0')}`;
    const createTime = baseTs + i * 600;
    const updateTime = createTime + 180;
    const msgUser = `u_${convId}`;
    const msgAssistant = `a_${convId}`;
    const msgAssistantAlt = `a_alt_${convId}`;

    const mapping: ChatGPTExportConversation['mapping'] = {
      root: {
        id: 'root',
        parent: null,
        children: [msgUser],
        message: null,
      },
      [msgUser]: {
        id: msgUser,
        parent: 'root',
        children: i === 1 ? [msgAssistant, msgAssistantAlt] : [msgAssistant],
        message: {
          id: msgUser,
          author: { role: 'user' },
          create_time: createTime,
          content: {
            content_type: 'text',
            parts: [
              `We are reviewing ${project} module #${i}. Decision: lock interface contract v${(i % 4) + 1} for thread ${convId}.`,
            ],
          },
        },
      },
      [msgAssistant]: {
        id: msgAssistant,
        parent: msgUser,
        children: [],
        message: {
          id: msgAssistant,
          author: { role: 'assistant' },
          create_time: updateTime,
          content: {
            content_type: 'text',
            parts: [
              `Confirmed interface contract v${(i % 4) + 1} for ${project} (#${i}). Next action: run integration check ${i}.`,
            ],
          },
        },
      },
    };

    if (i === 1 && mapping) {
      mapping[msgAssistantAlt] = {
        id: msgAssistantAlt,
        parent: msgUser,
        children: [],
        message: {
          id: msgAssistantAlt,
          author: { role: 'assistant' },
          create_time: updateTime + 30,
          content: {
            content_type: 'text',
            parts: [
              `Alternative branch exploration for ${project} (#${i}): test fallback schema before locking v${(i % 4) + 1}.`,
            ],
          },
        },
      };
    }

    items.push({
      id: convId,
      conversation_id: convId,
      title: `[#${i}] ${project} — Architecture & implementation thread ${i}`,
      create_time: createTime,
      update_time: updateTime,
      current_node: msgAssistant,
      project,
      tags: [project.split(' ')[0].toLowerCase(), `batch-${(i % 8) + 1}`],
      mapping,
    });
  }

  return items;
}

export function generate10kSyntheticMetadataRecords(
  count = 10000
): ConversationRecord[] {
  const projects = [
    'HypeStake',
    'Velotic / FrameConcepts',
    'Daydock / Meridian',
    'General research',
    'Personal',
    'Unfiled / Uncertain',
  ];
  const providers: Array<'chatgpt' | 'claude' | 'imported'> = [
    'chatgpt',
    'claude',
    'imported',
  ];
  const records: ConversationRecord[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const provider = providers[i % 3];
    const project = projects[i % projects.length];
    const convId = `synth10k_${i}`;
    const threadKey = buildThreadKey({
      provider,
      accountId: 'acct_benchmark_10k',
      workspaceId: 'ws_benchmark',
      sourceConversationId: convId,
      branchId: 'main',
    });
    const title = `[SYNTHETIC-10K #${i}] ${project} subsystem design & latency study ${i}`;
    records[i] = {
      threadKey,
      provider,
      accountId: 'acct_benchmark_10k',
      workspaceId: 'ws_benchmark',
      sourceConversationId: convId,
      branchId: 'main',
      parentBranchId: null,
      siblingBranchIds: [],
      canonicalUrl: `https://chatgpt.com/c/${convId}`,
      title,
      manualTitleOverride: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-20T00:00:00.000Z',
      lastCapturedAt: '2026-10-25T00:00:00.000Z',
      sourceRevision: 1,
      contentHash: computeDeterministicHash(title),
      coverage: i % 4 === 0 ? 'partial' : 'full',
      captureSource: 'synthetic_benchmark',
      messageCount: 20,
      project,
      categoryLocked: false,
      tags: ['synthetic-benchmark', project.split(' ')[0].toLowerCase()],
      manualTags: [],
      workflowState: i % 7 === 0 ? 'needs_review' : 'active',
      manualNotes: i === 4242 ? 'Needle phrase: meridian-quartz-calibrator-4242' : '',
      pinned: false,
      snoozedUntil: null,
      dismissedQueues: [],
      cloudExcluded: true,
      cloudTaskStatus: 'unsupported',
      isSyntheticBenchmark: true,
      latestDecisionText: `Committed benchmark parameter set ${i} for ${project}`,
      latestDecisionMsgIndex: 1,
      latestDecisionSpeaker: 'user_committed',
      nextStepText: `Verify throughput target ${i}`,
      nextStepMsgIndex: 2,
      nextStepSpeaker: 'assistant_suggested',
    };
  }

  return records;
}

export function generate10kSyntheticMessagesByThread(
  conversations: ConversationRecord[],
  messagesPerThread = 20
): Map<string, MessageRecord[]> {
  const map = new Map<string, MessageRecord[]>();
  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const list: MessageRecord[] = new Array(messagesPerThread);
    for (let m = 0; m < messagesPerThread; m++) {
      const role = m % 2 === 0 ? 'user' : 'assistant';
      const content =
        m === 3
          ? `Transcript turn ${m} for ${conv.project} (#${i}): body_token_alpha_${i} and scrubber_frame_budget_${i % 50} verified.`
          : m === 11
            ? `Decision turn ${m} for ${conv.project} (#${i}): meridian-body-calibrator-${i} with msgpack_delta_window_${i % 40} and optical grid check.`
            : `Message turn ${m} in ${conv.sourceConversationId} discussing ${conv.project} architecture, latency budget ${m * 5}ms, and schema revision v${(m % 4) + 1}.`;
      list[m] = {
        messageKey: `${conv.threadKey}:m:${m}`,
        threadKey: conv.threadKey,
        ordinal: m,
        sourceMessageId: `${conv.sourceConversationId}_m${m}`,
        role,
        content,
        createdAt: '2026-10-15T00:00:00.000Z',
        contentHash: `h_${i}_${m}`,
        hasCode: m % 5 === 0,
        hasArtifact: m % 10 === 0,
        branchPath: 'main',
      };
    }
    map.set(conv.threadKey, list);
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// Workspace demo library
// ---------------------------------------------------------------------------------------------

/** Ids of the demo's second accounts. Account ids never contain ':'. */
export const WORKSPACE_DEMO_ACCOUNT_IDS = { anthropicWork: 'acct_demowork01', openaiWork: 'acct_demowork02' } as const;

const DEMO_STAMP = '2026-01-05T09:00:00.000Z';

/**
 * The account rows the demo writes when they are missing: the browser's own sign-in labelled
 * "Personal" and a "Work" account for Claude and for ChatGPT. Saved cookies do not exist for
 * any of them (`hasJar` is false), so switching to a Work account in a real extension signs the
 * realm out. scripts/preview-server.mjs keeps a hand-written copy of this list; keep them in step.
 */
export const WORKSPACE_DEMO_ACCOUNTS: readonly AccountRecord[] = [
  {
    id: primaryAccountId('anthropic'),
    realm: 'anthropic',
    label: 'Personal',
    color: 'sage',
    mode: 'embedded',
    primary: true,
    identity: { key: 'demo-anthropic-personal', display: 'andrew@example.com', detail: null, observedAt: DEMO_STAMP, source: 'dom' },
    signedIn: 'yes',
    hasJar: false,
    order: 0,
    createdAt: DEMO_STAMP,
    lastActiveAt: DEMO_STAMP,
  },
  {
    id: WORKSPACE_DEMO_ACCOUNT_IDS.anthropicWork,
    realm: 'anthropic',
    label: 'Work',
    color: 'peach',
    mode: 'embedded',
    primary: false,
    identity: { key: 'demo-anthropic-work', display: 'andrew@work.example.com', detail: null, observedAt: DEMO_STAMP, source: 'dom' },
    signedIn: 'unknown',
    hasJar: false,
    order: 1,
    createdAt: DEMO_STAMP,
    lastActiveAt: null,
  },
  {
    id: primaryAccountId('openai'),
    realm: 'openai',
    label: 'Personal',
    color: 'blue',
    mode: 'embedded',
    primary: true,
    identity: { key: 'demo-openai-personal', display: 'andrew@example.com', detail: null, observedAt: DEMO_STAMP, source: 'dom' },
    signedIn: 'yes',
    hasJar: false,
    order: 0,
    createdAt: DEMO_STAMP,
    lastActiveAt: DEMO_STAMP,
  },
  {
    id: WORKSPACE_DEMO_ACCOUNT_IDS.openaiWork,
    realm: 'openai',
    label: 'Work',
    color: 'teal',
    mode: 'embedded',
    primary: false,
    identity: { key: 'demo-openai-work', display: 'andrew@work.example.com', detail: null, observedAt: DEMO_STAMP, source: 'dom' },
    signedIn: 'unknown',
    hasJar: false,
    order: 1,
    createdAt: DEMO_STAMP,
    lastActiveAt: null,
  },
];

type DemoTurn = { role: 'user' | 'assistant' | 'tool'; text: string };
const U = (text: string): DemoTurn => ({ role: 'user', text });
const A = (text: string): DemoTurn => ({ role: 'assistant', text });
/** A tool call and its result in the form the CLI importer writes. */
const T = (call: string, result: string): DemoTurn => ({ role: 'tool', text: `[tool] ${call}\n[tool result] ${result}` });

interface DemoSession {
  id: string;
  provider: ProviderId;
  /** 'work' selects the provider realm's second demo account; otherwise the bound account. */
  account?: 'work';
  url: string;
  title: string;
  project: string;
  minutesAgo: number;
  pinned?: boolean;
  tags?: string[];
  repository?: string;
  gitBranch?: string;
  pullRequestUrl?: string;
  providerProjectName?: string;
  agentState?: AgentState;
  turns: DemoTurn[];
}

const HS = 'hypestake/hypestake';
const DD = 'meridian/daydock';
const PR_HS = 'https://github.com/hypestake/hypestake/pull/412';

const DEMO_SESSIONS: DemoSession[] = [
  // ---- Claude Code on the web ----
  {
    id: 'session_01Hx7payments', provider: 'claude_code', url: 'https://claude.ai/code/session_01Hx7payments',
    title: 'Make the payments webhook idempotent', project: 'HypeStake', minutesAgo: 35, pinned: true,
    repository: HS, gitBranch: 'fix/webhook-idempotency', pullRequestUrl: PR_HS, providerProjectName: 'hypestake', agentState: 'turn_complete',
    turns: [
      U('Stripe retries our webhook and a deposit gets credited twice. Add idempotency keys to the payments webhook handler so a repeated event id is processed once.'),
      A('I will read the handler and its tests first, then add a unique constraint on the event id.'),
      T('Read: src/payments/webhooks.ts', 'handleWebhook credits the wallet on every payment_intent.succeeded delivery.'),
      A('Confirmed: nothing records which events were handled. I will store each event id in a webhook_events table and skip repeats.'),
      T('Edit: src/payments/idempotency.ts', 'Created src/payments/idempotency.ts'),
      T('Edit: src/payments/webhooks.ts', 'Updated src/payments/webhooks.ts'),
      T('Bash: pnpm test payments', 'Test Files 2 passed (2)\nTests 14 passed (14)'),
      A(`Duplicate deliveries now return 200 without crediting twice, and the new tests cover a replayed event. Pull request: ${PR_HS}`),
      U('Good. Keep the keys for 7 days so the table does not grow without bound.'),
      A('Added a nightly cleanup that deletes webhook_events older than 7 days, with a test. The pull request is updated.'),
    ],
  },
  {
    id: 'session_01Hx7oddsq', provider: 'claude_code', url: 'https://claude.ai/code/session_01Hx7oddsq',
    title: 'Move the odds engine onto a job queue', project: 'HypeStake', minutesAgo: 6, pinned: true,
    repository: HS, gitBranch: 'feat/odds-queue', providerProjectName: 'hypestake', agentState: 'running',
    turns: [
      U('The odds engine recalculates inline on every price tick and blocks the request. Move recalculation onto a queue worker.'),
      A('I will look at how ticks reach the engine, then add a queue between the feed and the recalculation.'),
      T('Grep: recalculateOdds', 'src/odds/engine.ts:41\nsrc/odds/feed.ts:88'),
      T('Read: src/odds/feed.ts', 'onTick(tick) { return recalculateOdds(tick.marketId); }'),
      A('The feed awaits recalculateOdds directly. I will enqueue one job per market and coalesce ticks that arrive while a job is waiting.'),
      T('Edit: src/odds/queue.ts', 'Created src/odds/queue.ts'),
      T('Edit: src/odds/feed.ts', 'Updated src/odds/feed.ts'),
      T('Bash: pnpm test odds', 'Test Files 3 passed (3)'),
      A('The feed now enqueues and returns. I am running the engine tests against the coalescing case.'),
    ],
  },
  {
    id: 'session_01Hy2locks', provider: 'claude_code', account: 'work', url: 'https://claude.ai/code/session_01Hy2locks',
    title: 'Review the wallet advisory lock change', project: 'HypeStake', minutesAgo: 70, pinned: true,
    repository: HS, gitBranch: 'fix/webhook-idempotency', pullRequestUrl: PR_HS, providerProjectName: 'hypestake', agentState: 'waiting_permission',
    turns: [
      U('Review the wallet crediting change on the webhook branch. Two requests for one wallet should never credit at the same time.'),
      A('I will read the diff and the wallet module.'),
      T('Bash: git diff main --stat', 'src/payments/webhooks.ts | 31 +++\nsrc/payments/idempotency.ts | 24 +++'),
      T('Read: src/wallet/credit.ts', 'creditWallet reads the balance, adds the amount and writes it back in two statements.'),
      A('Read, add, write without a lock can lose an update. Postgres advisory locks keyed on the wallet id would serialize crediting.'),
      T('Edit: src/wallet/credit.ts', 'Wrapped creditWallet in pg_advisory_xact_lock(hashtext(wallet_id)).'),
      A('The change needs a migration to confirm the lock function is available on staging. I need your approval to run `pnpm db:migrate` against staging.'),
    ],
  },
  {
    id: 'session_01Hy9signup', provider: 'claude_code', account: 'work', url: 'https://claude.ai/code/session_01Hy9signup',
    title: 'Signup page with a magic link', project: 'Daydock / Meridian', minutesAgo: 60 * 20,
    repository: DD, gitBranch: 'feat/magic-link-signup', pullRequestUrl: 'https://github.com/meridian/daydock/pull/57', providerProjectName: 'daydock', agentState: 'turn_complete',
    turns: [
      U('Build a signup page for Daydock that takes an email and sends a magic link. No passwords.'),
      A('I will add a form, a token table and a verify route. Tokens will be single use and expire after 15 minutes.'),
      T('Edit: src/signup/SignupPage.tsx', 'Created src/signup/SignupPage.tsx'),
      T('Edit: src/signup/magic-link.ts', 'Created src/signup/magic-link.ts'),
      T('Bash: pnpm test signup', 'Test Files 1 passed (1)\nTests 6 passed (6)'),
      A('The page posts the email, the server stores a hashed token and sends the link. Opening the link signs the person in and marks the token used. Pull request: https://github.com/meridian/daydock/pull/57'),
      U('What happens if someone requests ten links in a row?'),
      A('Right now each request issues a new token. I would add a limit of one request per address per minute; say so and I will add it.'),
    ],
  },
  // ---- Codex cloud ----
  {
    id: 'task_e_odds0f3', provider: 'codex', url: 'https://chatgpt.com/codex/tasks/task_e_odds0f3',
    title: 'Backfill odds snapshots for settled markets', project: 'HypeStake', minutesAgo: 140,
    repository: HS, gitBranch: 'chore/odds-backfill', pullRequestUrl: 'https://github.com/hypestake/hypestake/pull/418', providerProjectName: 'hypestake', agentState: 'waiting_answer',
    turns: [
      U('Settled markets are missing their final odds snapshot. Write a backfill that reads the last tick for each settled market and stores it.'),
      A('I will write the backfill as a script that runs in batches and can be run twice safely.'),
      T('Bash: sed -n 1,60p src/odds/snapshots.ts', 'export async function saveSnapshot(marketId, odds, at) { ... }'),
      T('Edit: scripts/backfill-odds-snapshots.ts', 'Created scripts/backfill-odds-snapshots.ts'),
      T('Bash: pnpm test odds-backfill', 'Test Files 1 passed (1)'),
      A('The script is ready and skips markets that already have a final snapshot. Pull request: https://github.com/hypestake/hypestake/pull/418'),
      A('One question before this runs for real: should markets that were voided get a snapshot too, or only markets that settled with a winner?'),
    ],
  },
  {
    id: 'task_e_logo7a1', provider: 'codex', url: 'https://chatgpt.com/codex/tasks/task_e_logo7a1',
    title: 'Export the Meridian logo grid as SVG', project: 'Daydock / Meridian', minutesAgo: 25, pinned: true,
    repository: DD, gitBranch: 'feat/logo-grid-export', providerProjectName: 'daydock', agentState: 'running',
    turns: [
      U('Export the Meridian logo grid as one SVG sprite so the site can reference each mark by id.'),
      A('I will read the existing logo files and build a sprite script.'),
      T('Bash: ls assets/logos', 'meridian-mark.svg\nmeridian-wordmark.svg\npartner-grid.svg'),
      T('Edit: scripts/build-logo-sprite.mjs', 'Created scripts/build-logo-sprite.mjs'),
      T('Bash: node scripts/build-logo-sprite.mjs', 'Wrote public/logos.svg with 3 symbols'),
      A('The sprite has one symbol per file. I am checking that every symbol keeps its viewBox.'),
    ],
  },
  {
    id: 'task_e_notes9c4', provider: 'codex', account: 'work', url: 'https://chatgpt.com/codex/tasks/task_e_notes9c4',
    title: 'Draft the release notes for Daydock 0.9', project: 'Daydock / Meridian', minutesAgo: 60 * 52,
    repository: DD, gitBranch: 'docs/release-notes', providerProjectName: 'daydock', agentState: 'turn_complete',
    turns: [
      U('Draft release notes for Daydock 0.9 from the merged pull requests since the last tag.'),
      T('Bash: git log v0.8.0..HEAD --oneline', 'a1c9e02 Add magic link signup\n5be7710 Fix dock icon spacing\n9d03f4c Speed up the launcher'),
      A('Three changes since v0.8.0. I will group them under Added, Fixed and Improved.'),
      T('Edit: docs/release-notes/0.9.md', 'Created docs/release-notes/0.9.md'),
      A('The notes list signup by magic link under Added, the icon spacing fix under Fixed and the launcher change under Improved. I did not add numbers I could not find in the log.'),
      U('Good, keep it that plain.'),
    ],
  },
  // ---- Cursor agents ----
  {
    id: 'bc-5f21a9', provider: 'cursor_agents', url: 'https://cursor.com/agents/bc-5f21a9',
    title: 'Advisory locks around bet settlement', project: 'HypeStake', minutesAgo: 90,
    repository: HS, gitBranch: 'fix/settlement-locks', providerProjectName: 'hypestake', agentState: 'failed',
    turns: [
      U('Settlement can run twice for one bet when two workers pick it up. Take an advisory lock per bet before settling.'),
      A('I will add the lock in the settlement function and a test that runs two settlements at once.'),
      T('Edit: src/settlement/settle.ts', 'Updated src/settlement/settle.ts'),
      T('Edit: src/settlement/settle.test.ts', 'Updated src/settlement/settle.test.ts'),
      T('Bash: pnpm test settlement', 'FAIL src/settlement/settle.test.ts\n1 failed | 4 passed\nError: could not obtain lock before test timeout'),
      A('The concurrent settlement test fails: the second worker waits for the lock and the test times out. I could not resolve it without changing the lock to try-lock, which changes behaviour.'),
    ],
  },
  // ---- ChatGPT ----
  {
    id: '6720c1d4-5e0a-4b8e-9a3c-logo001', provider: 'chatgpt', url: 'https://chatgpt.com/c/6720c1d4-5e0a-4b8e-9a3c-logo001',
    title: 'Logo grid spacing for the Daydock partner page', project: 'Daydock / Meridian', minutesAgo: 60 * 5, pinned: true,
    tags: ['logo', 'layout'],
    turns: [
      U('I have eight partner logos of different shapes. How do I lay them out in a grid so they look evenly weighted?'),
      A('Put each logo in a cell of equal size and scale by area rather than by width. Wide wordmarks get a lower height cap, square marks a higher one.'),
      U('Give me the CSS for that.'),
      A('Use a grid with auto-fit columns and a fixed cell height. Inside each cell, set max-width and max-height with object-fit: contain, and give wide logos a class with a smaller max-height.'),
      U('Should the grid be left aligned or centered on mobile?'),
      A('Centered. With two columns on a narrow screen a left-aligned last row looks like a mistake; centering the last row reads as intentional.'),
    ],
  },
  {
    id: '6731d0aa-7c12-4f09-b6d1-price002', provider: 'chatgpt', url: 'https://chatgpt.com/c/6731d0aa-7c12-4f09-b6d1-price002',
    title: 'Pricing check for the team plan', project: 'General research', minutesAgo: 60 * 30,
    turns: [
      U('We charge per seat. Help me check whether a flat team price is simpler to explain than per seat.'),
      A('A flat price is simpler to explain but punishes small teams and under-charges large ones. Per seat scales but needs a seat counter in billing.'),
      U('Our customers are mostly teams of three to five.'),
      A('For teams that size a per seat price stays easy to calculate in your head. I would keep per seat and add a clear price for each extra seat.'),
      U('Write the pricing line for the page.'),
      A('Team plan: one price per seat, billed monthly. Add or remove seats at any time.'),
    ],
  },
  // ---- Claude ----
  {
    id: '3c1e5b7a-9a14-4d02-8f55-notes003', provider: 'claude', url: 'https://claude.ai/chat/3c1e5b7a-9a14-4d02-8f55-notes003',
    title: 'Plain wording for HypeStake release notes', project: 'HypeStake', minutesAgo: 60 * 9,
    turns: [
      U('Rewrite these release notes so a bettor can read them: "Refactored the settlement worker, added idempotency to webhook ingestion, fixed a race in wallet credits."'),
      A('Deposits can no longer be credited twice. Bets settle once even when our systems retry. Fixed a case where two payments arriving together could show the wrong balance.'),
      U('Shorter, three bullets.'),
      A('- Deposits are credited once, even if a payment is retried.\n- Each bet settles once.\n- Your balance stays correct when two payments arrive together.'),
      U('Good. Add a one line intro.'),
      A('This update makes deposits and settlements safer. Here is what changed.'),
    ],
  },
  {
    id: '8e44a2f0-1b6d-4c3a-a7e9-pitch004', provider: 'claude', url: 'https://claude.ai/chat/8e44a2f0-1b6d-4c3a-a7e9-pitch004',
    title: 'Signup email subject lines for the magic link', project: 'Daydock / Meridian', minutesAgo: 60 * 22,
    turns: [
      U('Give me subject lines for the Daydock magic link email. It should say what it is without sounding like spam.'),
      A('Your Daydock sign-in link\nSign in to Daydock\nYour link to sign in to Daydock'),
      U('The first one. What should the first line of the email say?'),
      A('Use this link to sign in to Daydock. It works once and expires in 15 minutes.'),
      U('And if they did not ask for it?'),
      A('If you did not ask to sign in, you can ignore this email. Nobody can sign in without the link.'),
    ],
  },
  // ---- Grok ----
  {
    id: 'b21d9f73-0a5e-48c6-9c1f-grok005', provider: 'grok', url: 'https://grok.com/c/b21d9f73-0a5e-48c6-9c1f-grok005',
    title: 'Pricing page comparison of three sportsbook tools', project: 'General research', minutesAgo: 60 * 70,
    turns: [
      U('Compare how three odds-feed vendors present pricing on their public pricing pages. I want to know whether they list prices or ask you to call.'),
      A('Vendors in this space often hide prices behind a sales call. Check each page for a published number, a contact form, or both, and write down which one you find.'),
      U('I checked: one lists tiers, two ask for a call.'),
      A('Then the one with tiers sets the reference point buyers compare against. A published entry tier would give you the same advantage.'),
      U('Note that for the pricing check.'),
      A('Noted: of three vendors checked, one publishes tiers and two ask for a sales call.'),
    ],
  },
  // ---- Bots ----
  {
    id: '1893271645-1893271646', provider: 'grok_bot', url: 'https://x.com/i/chat/1893271645-1893271646',
    title: 'Odds alert bot: wording for suspended markets', project: 'HypeStake', minutesAgo: 60 * 3,
    turns: [
      U('When a market is suspended, the bot says "Market unavailable". That is vague. What should it say?'),
      A('Say what happened and what to do: "Betting on this market is paused. It usually reopens within a few minutes; check back or pick another market."'),
      U('Avoid promising a time.'),
      A('"Betting on this market is paused. Check back or pick another market."'),
      U('Use that.'),
      A('Updated. The suspended message now matches the paused wording used in the app.'),
    ],
  },
  {
    id: 'dot_demo_recap', provider: 'chatgpt_dots', url: 'https://chatgpt.com/dots/demo~recap',
    title: 'Weekly recap dot', project: 'Personal', minutesAgo: 60 * 26,
    turns: [
      U('Every Friday, summarize the notes I added this week into five lines.'),
      A('I will read the week\'s notes on Friday and write five lines: what I finished, what is blocked, one decision, one question, one thing to start Monday.'),
      U('Add a line for anything I should tell my accountant.'),
      A('Added a sixth line, "For the accountant", which stays empty when nothing applies.'),
      U('Fine. Keep it quiet when the week was empty.'),
      A('If there are no notes for the week I will say nothing instead of sending an empty recap.'),
    ],
  },
  {
    id: 'mu_trip_plan1', provider: 'muse', url: 'https://muse.ai/thread/mu_trip_plan1',
    title: 'Plan a quiet weekend in the mountains', project: 'Personal', minutesAgo: 60 * 44,
    turns: [
      U('Plan a quiet two night weekend in the mountains. No long drives, somewhere I can read.'),
      A('Pick a town within a two hour drive with a lodge that has a reading room or a fireplace. Book Friday evening arrival to avoid traffic.'),
      U('I would like to walk a little each morning.'),
      A('Choose a lodge near a marked trail under an hour long. Walk after breakfast and keep the afternoon free.'),
      U('Make it a short checklist.'),
      A('Lodge near a short trail, Friday evening arrival, two books, walking shoes, a paper map in case there is no signal.'),
    ],
  },
];

function demoThreadKey(s: DemoSession, boundAccountId: string, workspaceId: string): string {
  const accountId = s.account === 'work'
    ? (s.provider === 'codex' ? WORKSPACE_DEMO_ACCOUNT_IDS.openaiWork : WORKSPACE_DEMO_ACCOUNT_IDS.anthropicWork)
    : boundAccountId;
  return buildThreadKey({ provider: s.provider, accountId, workspaceId, sourceConversationId: s.id, branchId: 'main' });
}

/**
 * Workspace demo: coding-agent sessions, chats and bots spread over accounts and repositories,
 * so the Browse, Threads and Dashboard views have something to show. Safe to run again: a
 * session that already exists is left alone, and account rows are only added when missing.
 */
export async function seedWorkspaceDemoLibrary(db: ThreadStackDB): Promise<void> {
  const settings = await ensureStarterCollectionsAndSettings(db);
  const now = Date.now();
  const written: string[] = [];

  for (const s of DEMO_SESSIONS) {
    const bound = settings.boundAccounts[s.provider] ?? { accountId: 'acct_default', workspaceId: 'ws_personal' };
    const threadKey = demoThreadKey(s, bound.accountId, bound.workspaceId);
    if (await db.conversations.get(threadKey)) continue;
    const accountId = threadKey.split(':')[1];
    const start = now - s.minutesAgo * 60_000;
    const iso = (offsetMinutes: number) => new Date(start + offsetMinutes * 60_000).toISOString();
    const gap = s.provider === 'chatgpt' || s.provider === 'claude' || s.provider === 'grok' ? 3 : 1;
    const messages = s.turns.map((turn, i) => ({
      sourceMessageId: `${s.id}_m${i}`,
      role: turn.role,
      content: turn.text,
      createdAt: iso(i * gap),
    }));
    const result = await upsertThread(db, {
      threadKey,
      provider: s.provider,
      accountId,
      workspaceId: bound.workspaceId,
      sourceConversationId: s.id,
      branchId: 'main',
      canonicalUrl: s.url,
      title: s.title,
      createdAt: iso(0),
      updatedAt: iso((s.turns.length - 1) * gap),
      coverage: 'full',
      captureSource: s.provider === 'chatgpt' || s.provider === 'claude' || s.provider === 'grok' ? 'network_observer' : 'dom_observer',
      project: s.project,
      categoryLocked: true,
      tags: s.tags,
      pinned: s.pinned === true,
      isSyntheticBenchmark: false,
      providerProjectName: s.providerProjectName ?? null,
      gitBranch: s.gitBranch ?? null,
      repository: s.repository ?? null,
      pullRequestUrl: s.pullRequestUrl ?? null,
      agentState: s.agentState ?? null,
      messages,
    });
    if (result.status === 'stored') written.push(threadKey);
  }

  const existing = await db.accounts.bulkGet(WORKSPACE_DEMO_ACCOUNTS.map((a) => a.id));
  const missing = WORKSPACE_DEMO_ACCOUNTS.filter((_, i) => !existing[i]);
  if (missing.length) await db.accounts.bulkAdd(missing.map((a) => ({ ...a })));

  if (written.length) await processThreadsLocally(db, written, { aiDelaySeconds: 0 });
}
