import { getSmartTitle } from './insights.js';
import { providerLabel } from './providers.js';
import {
  THREAD_KIND_LABELS,
  type ConversationRecord,
  type ExtensionSummaryOutput,
  type ExtractedItem,
  type ProducedItem,
  type ThreadInsight,
  type WorkflowState,
} from './schema.js';

/**
 * A thread's summary as Markdown, built from stored data (never from rendered DOM text): the manager's
 * "Copy summary", the body of the Markdown handoff, and anything else that needs a portable summary.
 *
 * Pure and deterministic for a given input. Only basic blocks are emitted (headings, paragraphs, `- `
 * lists, `- [ ]` tasks, bold labels, inline code); never raw HTML. Untrusted text (titles and model
 * output) goes through `mdInline`, which neutralizes HTML, links and line-start block markers.
 */

export interface SummaryMarkdownInput {
  conv: ConversationRecord;
  insight: ThreadInsight | null;
  summary: ExtensionSummaryOutput | null;
}

export interface SummaryMarkdownOptions {
  /** Start with `# Title` and a one-line meta row (default true). */
  title?: boolean;
  /** End with the Context section: topics, mentions, project, provider, workspace, resume command (default true). */
  context?: boolean;
  /** Level of the section headings (default 2; the title is one level above). */
  headingLevel?: 2 | 3;
}

export const WORKFLOW_STATE_LABELS: Record<WorkflowState, string> = {
  active: 'Active',
  needs_review: 'Needs review',
  waiting: 'Waiting',
  paused: 'Paused',
  done: 'Done',
  archived: 'Archived',
};

const AGENT_WAITING_LABELS = {
  permission: 'your approval',
  input: 'your answer',
  ci: 'CI checks',
  external: 'something outside the run',
} as const;

/**
 * One line of untrusted text, safe to embed in Markdown: whitespace collapsed, raw HTML and link syntax
 * neutralized, and a leading block marker (heading, quote, list, table, rule) escaped so the text can
 * never open a block of its own.
 */
export function mdInline(text: string | null | undefined): string {
  let t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  t = t.replace(/\\/g, '\\\\').replace(/([<>[\]])/g, '\\$1');
  // Line-start markers: "# ", "> ", "- ", "+ ", "* ", "1. ", "1) ", "|", "=", "---", "```", "~~~".
  t = t.replace(/^(#{1,6}(?=\s|$)|[-+*](?=\s|$)|\||=|`{3,}|~{3,})/, '\\$1');
  t = t.replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2');
  return t;
}

/** Inline code with a fence long enough for any backticks inside. */
export function mdCode(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
}

/** 0-based message ordinals as the UI shows them: `(m3)` or `(m3, m5)`; '' when none. */
export function mdRefs(indexes: Array<number | null | undefined>): string {
  const refs = Array.from(new Set(indexes.filter((i): i is number => typeof i === 'number' && i >= 0))).map(
    (i) => `m${i + 1}`
  );
  return refs.length ? ` (${refs.join(', ')})` : '';
}

/** "claude-opus-5-5" / "anthropic.claude-sonnet-5-5-v1" → "Claude Opus 5.5"; other ids pass through. */
export function analysisModelLabel(model: string): string {
  const m = model.replace(/^anthropic\./, '').match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  if (!m) return model;
  return `Claude ${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
}

/** Overview paragraphs to show: v2 `overview`, else the legacy one-paragraph summary unless it repeats the gist. */
export function overviewParagraphs(insight: ThreadInsight | null): string[] {
  if (!insight) return [];
  const gist = insight.gist.replace(/\s+/g, ' ').trim();
  const paragraphs = insight.overview?.length ? insight.overview : insight.summary ? [insight.summary] : [];
  return paragraphs.map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p && p !== gist);
}

/** What the thread produced: v2 `produced` (with descriptions), else the legacy `artifacts`. */
export function producedItems(insight: ThreadInsight | null): ProducedItem[] {
  if (!insight) return [];
  if (insight.produced?.length) return insight.produced;
  return insight.artifacts.map((a) => ({ label: a.label, kind: a.kind, description: '', messageIndex: a.messageIndex }));
}

/** A claim's text with its rationale: "Use a table — so retries cannot double-charge". */
export function claimText(item: Pick<ExtractedItem, 'text' | 'rationale'>): string {
  const text = item.text.replace(/\s+/g, ' ').trim().replace(/[.;:,]+$/, '');
  const rationale = (item.rationale ?? '').replace(/\s+/g, ' ').trim();
  if (!rationale) return item.text.replace(/\s+/g, ' ').trim();
  return `${text} — ${rationale.charAt(0).toLowerCase()}${rationale.slice(1)}`;
}

function dateOnly(iso: string | null | undefined): string {
  return iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '';
}

export function buildSummaryMarkdown(input: SummaryMarkdownInput, options: SummaryMarkdownOptions = {}): string {
  const { conv, insight, summary } = input;
  const level = options.headingLevel ?? 2;
  const h = (text: string) => `${'#'.repeat(level)} ${text}`;
  const blocks: string[] = [];
  const push = (...lines: string[]) => {
    const block = lines.filter((l) => l !== '').join('\n');
    if (block) blocks.push(block);
  };

  if (options.title !== false) {
    push(`${'#'.repeat(level - 1)} ${mdInline(getSmartTitle(conv, insight)) || 'Untitled thread'}`);
    const meta = [
      providerLabel(conv.provider),
      conv.project,
      insight ? THREAD_KIND_LABELS[insight.kind] : '',
      WORKFLOW_STATE_LABELS[conv.workflowState] ?? conv.workflowState,
      dateOnly(conv.updatedAt) ? `updated ${dateOnly(conv.updatedAt)}` : '',
      conv.messageCount > 0 ? `${conv.messageCount} message${conv.messageCount === 1 ? '' : 's'}` : '',
    ]
      .map((p) => mdInline(p))
      .filter(Boolean);
    if (meta.length) push(`_${meta.join(' · ')}_`);
  }

  // What this thread is about
  const paragraphs = overviewParagraphs(insight);
  const glance = insight
    ? [
        insight.userGoal ? `- **Goal:** ${mdInline(insight.userGoal)}` : '',
        insight.outcome ? `- **Outcome:** ${mdInline(insight.outcome)}` : '',
        insight.statusReason
          ? `- **Status:** ${mdInline(insight.statusReason)} (${WORKFLOW_STATE_LABELS[conv.workflowState] ?? conv.workflowState})`
          : '',
      ].filter(Boolean)
    : [];
  if (insight && (insight.gist || paragraphs.length || glance.length)) {
    push(h('What this thread is about'));
    if (insight.gist) push(`**${mdInline(insight.gist)}**`);
    for (const p of paragraphs) push(mdInline(p));
    if (glance.length) push(...glance);
  } else if (!insight && !summary) {
    push(h('What this thread is about'));
    push('Not analyzed yet.');
  }

  const keyPoints = summary?.keyPoints ?? [];
  if (keyPoints.length) {
    push(h('Key points'));
    push(...keyPoints.map((k) => `- ${mdInline(k.text)}${mdRefs(k.messageIndexes)}`));
  }

  if (summary?.whereYouLeftOff || summary?.nextStep) {
    push(h('Where you left off'));
    if (summary.whereYouLeftOff) push(`${mdInline(summary.whereYouLeftOff)}${mdRefs(summary.whereYouLeftOffMessageIndexes)}`);
    if (summary.nextStep) push(`**Next step:** ${mdInline(summary.nextStep)}`);
  }

  if (summary?.decisions.length) {
    push(h('Decisions'));
    push(
      ...summary.decisions.map(
        (d) =>
          `- ${d.speaker === 'user_committed' ? 'You decided' : 'Suggested'}: ${mdInline(claimText(d))}${mdRefs(d.messageIndexes)}`
      )
    );
  }

  if (summary?.actionItems.length) {
    push(h('Next steps'));
    push(...summary.actionItems.map((a) => `- [ ] ${mdInline(a.text)}${mdRefs(a.messageIndexes)}`));
  }

  if (summary?.openQuestions.length) {
    push(h('Open questions'));
    push(...summary.openQuestions.map((q) => `- ${mdInline(q.text)}${mdRefs(q.messageIndexes)}`));
  }

  const produced = producedItems(insight);
  if (produced.length) {
    push(h('What was produced'));
    push(
      ...produced.map(
        (p) =>
          `- **${mdInline(p.label)}** (${p.kind})${p.description ? ` — ${mdInline(p.description)}` : ''}${mdRefs([p.messageIndex])}`
      )
    );
  }

  const run = insight?.agentRun;
  if (run) {
    const lines: string[] = [];
    const repository = run.repository ?? conv.repository;
    if (repository) lines.push(`- **Repository:** ${mdCode(repository)}`);
    if (run.branch) lines.push(`- **Branch:** ${mdCode(run.branch)}`);
    if (run.pullRequests.length) {
      const links = run.pullRequests.map((p) => {
        const url = /^https:\/\//.test(p.url) ? p.url.replace(/[<>\s]/g, '') : '';
        return url ? `<${url}>${p.state === 'unknown' ? '' : ` (${p.state})`}` : '';
      });
      lines.push(`- **Pull requests:** ${links.filter(Boolean).join(', ')}`);
    }
    if (run.filesChanged.length) lines.push(`- **Files changed:** ${run.filesChanged.map((f) => mdCode(f)).join(', ')}`);
    if (run.commandsRun.length) {
      lines.push('- **Commands:**');
      for (const c of run.commandsRun) lines.push(`  - ${mdCode(c.command)}${c.outcome === 'unknown' ? '' : ` (${c.outcome})`}`);
    }
    if (run.tests.status !== 'unknown') {
      const status = run.tests.status === 'not_run' ? 'not run' : run.tests.status;
      lines.push(`- **Tests:** ${status}${run.tests.detail ? ` (${mdInline(run.tests.detail)})` : ''}`);
    }
    if (run.blockedOn !== 'none') lines.push(`- **Waiting on:** ${AGENT_WAITING_LABELS[run.blockedOn]}`);
    if (lines.length) {
      push(h('Agent run'));
      push(...lines);
    }
  }

  if (options.context !== false) {
    const lines: string[] = [];
    if (insight?.topics.length) lines.push(`- **Topics:** ${insight.topics.map((t) => mdInline(t)).join(', ')}`);
    if (insight?.entities.length) lines.push(`- **Mentions:** ${insight.entities.map((e) => mdInline(e)).join(', ')}`);
    lines.push(`- **Project:** ${mdInline(conv.project)}`);
    lines.push(`- **Provider:** ${mdInline(providerLabel(conv.provider))}${conv.modelSlug ? ` · ${mdCode(conv.modelSlug)}` : ''}`);
    if (conv.workspacePath) {
      lines.push(`- **Workspace:** ${mdCode(conv.workspacePath)}${conv.gitBranch ? ` on ${mdCode(conv.gitBranch)}` : ''}`);
    }
    if (conv.resumeCommand) lines.push(`- **Resume:** ${mdCode(conv.resumeCommand)}`);
    if (/^https:\/\//.test(conv.canonicalUrl)) lines.push(`- **Original:** <${conv.canonicalUrl.replace(/[<>\s]/g, '')}>`);
    if (insight) {
      lines.push(
        insight.source === 'ai'
          ? `- **Analysis:** ${mdInline(analysisModelLabel(insight.model))}${dateOnly(insight.generatedAt) ? `, ${dateOnly(insight.generatedAt)}` : ''}`
          : '- **Analysis:** on-device'
      );
    }
    push(h('Context'));
    push(...lines);
  }

  return `${blocks.join('\n\n')}\n`;
}
