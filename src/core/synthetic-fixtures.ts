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
  type ThreadkeeperDB,
} from './db.js';
import type { ChatGPTExportConversation } from './adapters.js';

export async function seedSyntheticWorkbenchLibrary(
  db: ThreadkeeperDB,
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
