import { providerCategory, providerLabel } from './providers.js';
import { normalizePullRequestUrl, normalizeRepository, hasRepositoryOwner } from './repository.js';
import { AGENT_STATE_LABELS, agentStateNeedsYou } from './workspace/types.js';
import {
  THREAD_KINDS,
  getDisplayTitle,
  insightKeyFor,
  type AgentRunFacts,
  type ArtifactKind,
  type ConversationRecord,
  type ExtensionSummaryOutput,
  type ExtractedItem,
  type MessageRecord,
  type ThreadInsight,
  type ThreadKind,
  type WorkflowState,
} from './schema.js';
import { containsPromptInjectionAttempt } from '../../shared/cloud.js';

export const LOCAL_ANALYZER_MODEL = 'local-heuristics-v3';

const STOPWORDS = new Set(
  `a about above after again against all also am an and any are aren't as at be because been before being below
between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for
from further get got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him
himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself just let let's like make me more most
mustn't my myself need no nor not now of off ok okay on once one only or other ought our ours ourselves out over own
please same shan't she she'd she'll she's should shouldn't so some such sure than thank thanks that that's the their
theirs them themselves then there there's these they they'd they'll they're they've this those through to too under
until up us use used using very want was wasn't way we we'd we'll we're we've well were weren't what what's when
when's where where's which while who who's whom why why's will with won't would wouldn't yes yet you you'd you'll
you're you've your yours yourself yourselves also really still even much many lot lots thing things something anything
everything new good great better best right left first last next back go going gonna know think see look looks looking
help give take put say said tell try trying want wants wanted work works working done do does did make makes made
able etc via per vs within without across around may might must shall each every either neither however therefore
here's actually basically simply kind sort maybe probably perhaps currently already another based example following
include including includes provide provided provides question answer below above code file files time way ways part
different same sure yeah hey hi hello claude chatgpt gpt grok gemini copilot assistant user
day days week weeks month months year years today tomorrow yesterday time times twice returns return
recommendation recommendations suggestion suggestions step steps result results number numbers option
options approach detail details information info stuff point points case cases`
    .split(/\s+/)
    .filter(Boolean)
);

const TECH_TERMS: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  python: 'python',
  rust: 'rust',
  golang: 'go',
  java: 'java',
  kotlin: 'kotlin',
  swift: 'swift',
  swiftui: 'swiftui',
  react: 'react',
  'react native': 'react-native',
  nextjs: 'nextjs',
  'next.js': 'nextjs',
  vue: 'vue',
  svelte: 'svelte',
  angular: 'angular',
  tailwind: 'tailwind',
  node: 'nodejs',
  'node.js': 'nodejs',
  deno: 'deno',
  bun: 'bun',
  django: 'django',
  flask: 'flask',
  fastapi: 'fastapi',
  rails: 'rails',
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  sqlite: 'sqlite',
  mongodb: 'mongodb',
  redis: 'redis',
  supabase: 'supabase',
  firebase: 'firebase',
  prisma: 'prisma',
  graphql: 'graphql',
  docker: 'docker',
  kubernetes: 'kubernetes',
  terraform: 'terraform',
  aws: 'aws',
  gcp: 'gcp',
  azure: 'azure',
  cloudflare: 'cloudflare',
  vercel: 'vercel',
  stripe: 'stripe',
  openai: 'openai',
  anthropic: 'anthropic',
  'claude code': 'claude-code',
  codex: 'codex',
  llm: 'llm',
  rag: 'rag',
  embeddings: 'embeddings',
  pytorch: 'pytorch',
  tensorflow: 'tensorflow',
  pandas: 'pandas',
  numpy: 'numpy',
  excel: 'excel',
  figma: 'figma',
  'chrome extension': 'chrome-extension',
  playwright: 'playwright',
  vite: 'vite',
  webpack: 'webpack',
  git: 'git',
  github: 'github',
  sql: 'sql',
  css: 'css',
  html: 'html',
  bash: 'bash',
  regex: 'regex',
  ios: 'ios',
  android: 'android',
  seo: 'seo',
};

const LANGUAGE_FENCES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  typescript: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  javascript: 'javascript',
  py: 'python',
  python: 'python',
  rs: 'rust',
  rust: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kotlin: 'kotlin',
  swift: 'swift',
  rb: 'ruby',
  ruby: 'ruby',
  php: 'php',
  cs: 'csharp',
  csharp: 'csharp',
  cpp: 'cpp',
  c: 'c',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
  html: 'html',
  css: 'css',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
};

const KIND_RULES: Array<[ThreadKind, RegExp, number]> = [
  [
    'debugging',
    /\b(error|exception|stack ?trace|traceback|bug|crash(?:es|ed|ing)?|fail(?:s|ed|ing)?|broken|doesn'?t work|not working|typeerror|referenceerror|syntaxerror|segfault|undefined is not|cannot read propert|fix (?:this|the|my|it)|debug(?:ging)?|regression|404|500 error|timeout)\b/gi,
    2.6,
  ],
  [
    'coding',
    /\b(function|component|implement|refactor|api|endpoint|class|module|code|script|repo|pull request|unit tests?|deploy|database|schema|migration|regex|typescript|javascript|python|react|backend|frontend|cli|sdk|library|compile|build (?:a|an|the)|feature)\b/gi,
    1.3,
  ],
  [
    'writing',
    /\b(write|rewrite|draft|edit|proofread|essay|email|blog|post|article|copy(?:writing)?|tone|paragraph|cover letter|tweet|linkedin|newsletter|headline|tagline|story|speech|bio|press release)\b/gi,
    2,
  ],
  [
    'research',
    /\b(research|compare|comparison|versus|pros and cons|sources?|evidence|stud(?:y|ies)|market size|landscape|competitors?|alternatives?|which is better|benchmark|review of)\b/gi,
    2,
  ],
  [
    'planning',
    /\b(plan|roadmap|strategy|timeline|milestones?|schedule|itinerary|prioriti[sz]e|okrs?|goals?|launch plan|checklist|next quarter)\b/gi,
    1.8,
  ],
  [
    'brainstorming',
    /\b(ideas?|brainstorm|names? for|suggestions?|come up with|concepts?|options for|naming)\b/gi,
    1.8,
  ],
  [
    'learning',
    /\b(explain|how does|what is|what are|why does|why is|teach me|understand|eli5|tutorial|learn|difference between)\b/gi,
    1.4,
  ],
  [
    'data',
    /\b(dataset|csv|spreadsheet|excel|pandas|dataframe|charts?|graphs?|statistic(?:s|al)?|regression|analy[sz]e|analysis|metrics?|dashboard|kpis?|cohort|forecast)\b/gi,
    1.8,
  ],
  [
    'design',
    /\b(design|logo|ui|ux|layout|figma|typography|fonts?|colou?r palette|brand(?:ing)?|mockup|wireframe|icons?|visual identity|landing page)\b/gi,
    1.8,
  ],
  [
    'business',
    /\b(pricing|revenue|customers?|investors?|pitch|startup|go-to-market|gtm|sales|marketing|business model|fundrais\w*|valuation|contract|legal|hiring|equity|margin|churn)\b/gi,
    1.8,
  ],
  [
    'personal',
    /\b(health|diet|workout|recipe|travel|trip|vacation|family|wedding|gift|apartment|relationship|doctor|symptoms?|budget(?:ing)?|taxes?|mortgage)\b/gi,
    1.8,
  ],
];

const DECISION_RE =
  /\b(let'?s go with|let'?s use|we(?:'ll| will) (?:go with|use|ship)|i(?:'ll| will) (?:go with|use)|(?:we |i )?decided (?:to|on)|decision:|going with|settled on|we chose|i chose|final(?:ly)? (?:choice|decision)|agreed to|we agreed)\b/i;
const RECOMMEND_RE = /\b(i recommend|my recommendation|you should (?:go with|use)|the best option is|recommended approach)\b/i;
const ACTION_LINE_RE =
  /^\s*(?:[-*]\s*\[ \]|todo:?|next steps?:?|action items?:?|\d+\.\s+(?=\w))/i;
const USER_INTENT_RE = /\b(i need to|i(?:'ll| will) |remind me to|i have to|i should|we need to|next i(?:'ll| will| need))\b/i;
const CLOSING_RE =
  /\b(thanks?|thank you|perfect|that worked|works now|it works|working now|solved|awesome|great,? (?:that|it) works|all good|that'?s it|resolved)\b/i;
/** A thank-you that carries a problem, a new request or a question is not a wrap-up. */
const NOT_CLOSED_RE =
  /\?|\b(but|still|however|although|though|doesn'?t|does not|didn'?t|did not|isn'?t|is not|won'?t|can'?t|cannot|not working|error|errors|fails?|failed|failing|broken|issue|problem|wrong|next|now|also|another|can you|could you|please|how (?:do|can|would|should))\b/i;

export function isClosingMessage(text: string): boolean {
  const clean = stripCode(text).trim();
  return clean.length < 160 && CLOSING_RE.test(clean) && !NOT_CLOSED_RE.test(clean);
}

const ASSISTANT_QUESTION_RE =
  /(would you like|do you want|should i|shall i|want me to|let me know if|which (?:one|option) (?:do|would) you|can you (?:share|confirm|provide|clarify))[^?]{0,200}\?/i;

const GREETING_RE = /^(?:(?:hi|hey|hello|yo|good (?:morning|afternoon|evening))(?:\s+(?:there|claude|chatgpt|grok|gemini|copilot))?[,!.\s]+)/i;
const POLITE_PREFIX_RE =
  /^(?:(?:so|ok(?:ay)?|alright|um+|well)[,\s]+)?(?:(?:can|could|would|will) you(?: please)?|please|i (?:want|need|would like|'d like) (?:you )?to|i want you to|help me(?: to)?|i need help(?: with)?|i'm trying to|i am trying to|i want to|i need to|let'?s)\s+/i;

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`]*`/g, ' ');
}

export function firstSentence(text: string, max = 160): string {
  const clean = normalizeSpace(stripCode(text));
  if (!clean) return '';
  const m = clean.match(/^(.{12,}?[.!?])(\s|$)/);
  const sentence = m ? m[1] : clean;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

function lastSentence(text: string, max = 200): string {
  const clean = normalizeSpace(stripCode(text));
  const parts = clean.split(/(?<=[.!?])\s+/).filter((p) => p.length > 0);
  const s = parts[parts.length - 1] ?? clean;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Turn the opening request into a compact "what this is about" line. */
export function deriveGist(firstUserMessage: string, max = 140): string {
  let text = normalizeSpace(stripCode(firstUserMessage));
  if (!text) return '';
  text = text.replace(GREETING_RE, '');
  for (let i = 0; i < 2; i++) text = text.replace(POLITE_PREFIX_RE, '');
  const sentence = firstSentence(text, max).replace(/[?.!]+$/, '');
  return capitalize(sentence);
}

const GENERIC_TITLES = /^(new chat|untitled( conversation| claude conversation)?|chatgpt|claude|grok|gemini|copilot|new conversation|conversation|chat|claude code session|codex session)$/i;

export function isGenericTitle(title: string | null | undefined): boolean {
  const t = normalizeSpace(title ?? '');
  return t.length < 3 || GENERIC_TITLES.test(t);
}

function tokenizeForTopics(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9.+#\s-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t.length >= 3 && t.length <= 30 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/**
 * Frequency-weighted keyword and bigram extraction; title and user turns weigh
 * more. A term must recur across separate texts (title, turns) to count, so a
 * short thread does not turn every adjacent title word pair into a "topic".
 */
export function extractKeyTerms(
  weightedTexts: Array<{ text: string; weight: number }>,
  limit = 8
): string[] {
  const unigram = new Map<string, { score: number; docs: number }>();
  const bigram = new Map<string, { score: number; docs: number }>();
  const bump = (map: Map<string, { score: number; docs: number }>, key: string, weight: number, seen: Set<string>) => {
    const entry = map.get(key) ?? { score: 0, docs: 0 };
    entry.score += weight;
    if (!seen.has(key)) {
      entry.docs += 1;
      seen.add(key);
    }
    map.set(key, entry);
  };
  for (const { text, weight } of weightedTexts) {
    const tokens = tokenizeForTopics(stripCode(text));
    const seen = new Set<string>();
    for (let i = 0; i < tokens.length; i++) {
      bump(unigram, tokens[i], weight, seen);
      if (i + 1 < tokens.length) bump(bigram, `${tokens[i]} ${tokens[i + 1]}`, weight, seen);
    }
  }
  const scored: Array<[string, number]> = [];
  for (const [bg, { score, docs }] of bigram) {
    if (docs >= 2 && score >= 3) scored.push([bg, score * 1.6]);
  }
  for (const [ug, { score, docs }] of unigram) {
    if (docs >= 2 || (score >= 3 && ug.length >= 5)) scored.push([ug, score * (ug.length >= 6 ? 1.15 : 1)]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  const picked: string[] = [];
  for (const [term] of scored) {
    if (picked.length >= limit) break;
    const parts = term.split(' ');
    if (picked.some((p) => p === term || (parts.length === 1 && p.split(' ').includes(term)))) continue;
    if (parts.length === 2) {
      // a bigram subsumes its weaker unigrams
      for (let i = picked.length - 1; i >= 0; i--) {
        if (parts.includes(picked[i])) picked.splice(i, 1);
      }
    }
    picked.push(term);
  }
  return picked;
}

function detectTechnologies(text: string): string[] {
  const lower = ` ${text.toLowerCase()} `;
  const found = new Set<string>();
  for (const [needle, tag] of Object.entries(TECH_TERMS)) {
    const re = new RegExp(`[^a-z0-9]${needle.replace(/[.+]/g, '\\$&')}[^a-z0-9]`);
    if (re.test(lower)) found.add(tag);
  }
  return Array.from(found);
}

function detectLanguages(messages: MessageRecord[]): string[] {
  const langs = new Set<string>();
  for (const m of messages) {
    for (const match of m.content.matchAll(/```([\w+#-]+)/g)) {
      const lang = LANGUAGE_FENCES[match[1].toLowerCase()];
      if (lang) langs.add(lang);
    }
  }
  return Array.from(langs);
}

const FILE_RE =
  /\b[\w./-]*[\w-]+\.(?:tsx?|jsx?|mjs|py|rs|go|java|kt|swift|rb|php|cs|cpp|c|h|sql|css|scss|html|md|json|ya?ml|toml|sh|ipynb|csv|xlsx|pdf|docx|pptx|png|svg)\b/g;

function detectArtifacts(messages: MessageRecord[]): ThreadInsight['artifacts'] {
  const out: ThreadInsight['artifacts'] = [];
  const seen = new Set<string>();
  const add = (label: string, kind: ArtifactKind, messageIndex: number) => {
    const key = `${kind}:${label.toLowerCase()}`;
    if (seen.has(key) || out.length >= 10) return;
    seen.add(key);
    out.push({ label, kind, messageIndex });
  };
  for (const m of messages) {
    if (m.role === 'tool') continue;
    for (const f of m.content.match(FILE_RE) ?? []) {
      if (f.length <= 80 && !/^\d/.test(f)) {
        const kind: ArtifactKind = /\.(csv|xlsx|json|sql|ipynb)$/.test(f)
          ? 'data'
          : /\.(md|docx|pdf|pptx)$/.test(f)
            ? 'document'
            : /\.(png|svg)$/.test(f)
              ? 'design'
              : 'code';
        add(f, kind, m.ordinal);
      }
    }
    for (const u of m.content.match(/https?:\/\/[^\s)>\]"']+/g) ?? []) {
      try {
        const url = new URL(u);
        add(`${url.hostname.replace(/^www\./, '')}${url.pathname.length > 1 ? url.pathname.slice(0, 40) : ''}`, 'link', m.ordinal);
      } catch {
        // ignore malformed URLs
      }
    }
  }
  return out;
}

const CAPITALIZED_RE = /(?<![.!?]\s|^|\n)\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*(?:\s+[A-Z][a-z0-9]+){0,2})\b/g;
const ENTITY_STOP = new Set([
  'I', 'The', 'This', 'That', 'These', 'Those', 'It', 'If', 'In', 'On', 'For', 'And', 'But', 'Or', 'You', 'We',
  'My', 'Your', 'Our', 'Here', 'There', 'What', 'When', 'Where', 'Why', 'How', 'Yes', 'No', 'Thanks', 'Please',
  'Claude', 'ChatGPT', 'Note', 'Step', 'Option', 'Example', 'Also', 'However', 'Then', 'Now', 'Next', 'First',
  'Second', 'Finally', 'Let', 'Sure', 'Okay', 'OK', 'Great', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
  'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December', 'True', 'False', 'None', 'Null', 'Error', 'Summary', 'Overview',
]);

function detectEntities(messages: MessageRecord[], title: string): string[] {
  const counts = new Map<string, number>();
  const texts = [title, ...messages.filter((m) => m.role !== 'tool').map((m) => stripCode(m.content))];
  for (const text of texts) {
    for (const match of text.matchAll(CAPITALIZED_RE)) {
      const name = match[1].trim();
      const head = name.split(/\s+/)[0];
      if (ENTITY_STOP.has(head) || name.length < 3) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([n]) => n);
}

export function classifyKind(
  conv: Pick<ConversationRecord, 'provider'>,
  title: string,
  messages: MessageRecord[]
): ThreadKind {
  const userTexts = messages.filter((m) => m.role === 'user').map((m) => stripCode(m.content));
  const opening = userTexts.slice(0, 3).join('\n');
  const rest = userTexts.slice(3).join('\n').slice(0, 8000);
  const scores = new Map<ThreadKind, number>();
  for (const [kind, re, weight] of KIND_RULES) {
    const count = (s: string) => (s.match(re) ?? []).length;
    scores.set(kind, (count(title) * 2.5 + count(opening) * 1.5 + count(rest) * 0.5) * weight);
  }
  const hasCode = messages.some((m) => m.hasCode && /```/.test(m.content));
  if (hasCode) scores.set('coding', (scores.get('coding') ?? 0) + 5);
  if (providerCategory(conv.provider) === 'coding_agent') {
    scores.set('coding', (scores.get('coding') ?? 0) + 8);
  }
  // A coding thread dominated by error talk is a debugging thread.
  if ((scores.get('debugging') ?? 0) >= (scores.get('coding') ?? 0) * 0.6 && (scores.get('debugging') ?? 0) >= 5) {
    scores.set('debugging', (scores.get('debugging') ?? 0) + (scores.get('coding') ?? 0));
  }
  let best: ThreadKind = 'other';
  let bestScore = 3;
  for (const kind of THREAD_KINDS) {
    const s = scores.get(kind) ?? 0;
    if (s > bestScore) {
      best = kind;
      bestScore = s;
    }
  }
  return best;
}

function sentencesOf(text: string): string[] {
  return stripCode(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 400);
}

function item(
  text: string,
  message: MessageRecord,
  quote: string,
  speaker: ExtractedItem['speaker'],
  provenance: ExtractedItem['provenance'] = 'explicit'
): ExtractedItem {
  return {
    text: text.length > 220 ? `${text.slice(0, 219)}…` : text,
    messageIndexes: [message.ordinal],
    evidenceQuote: quote,
    provenance,
    speaker,
  };
}

function extractDecisions(messages: MessageRecord[]): ExtractedItem[] {
  const found: ExtractedItem[] = [];
  for (let i = messages.length - 1; i >= 0 && found.length < 5; i--) {
    const m = messages[i];
    if (m.role === 'tool' || m.role === 'system') continue;
    for (const s of sentencesOf(m.content)) {
      if (m.role === 'user' && DECISION_RE.test(s)) {
        found.push(item(s, m, s, 'user_committed'));
      } else if (m.role === 'assistant' && RECOMMEND_RE.test(s)) {
        found.push(item(s, m, s, 'assistant_suggested', 'inferred'));
      }
      if (found.length >= 5) break;
    }
  }
  return found.reverse();
}

function extractActionItems(messages: MessageRecord[]): ExtractedItem[] {
  const found: ExtractedItem[] = [];
  const tail = messages.slice(-6);
  for (const m of tail) {
    if (m.role === 'tool' || m.role === 'system') continue;
    const lines = stripCode(m.content).split('\n');
    let inNextSteps = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (/^(#+\s*)?(next steps?|action items?|to ?do|todo)\b:?/i.test(line)) {
        inNextSteps = true;
        continue;
      }
      const isListItem = /^([-*]|\d+[.)])\s+/.test(line);
      if (
        (inNextSteps && isListItem) ||
        /^\s*[-*]\s*\[ \]/.test(line) ||
        /^todo:/i.test(line) ||
        (m.role === 'user' && USER_INTENT_RE.test(line))
      ) {
        const text = line.replace(/^([-*]\s*(\[ \])?|\d+[.)]|todo:)\s*/i, '').trim();
        if (text.length >= 12) {
          found.push(item(text, m, text.slice(0, 200), m.role === 'user' ? 'user_committed' : 'assistant_suggested'));
        }
      } else if (!isListItem && inNextSteps && !ACTION_LINE_RE.test(line)) {
        inNextSteps = false;
      }
      if (found.length >= 6) return found;
    }
  }
  return found;
}

function extractOpenQuestions(messages: MessageRecord[]): ExtractedItem[] {
  const found: ExtractedItem[] = [];
  const dialog = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const last = dialog[dialog.length - 1];
  if (!last) return found;
  if (last.role === 'user') {
    const qs = sentencesOf(last.content).filter((s) => s.endsWith('?'));
    for (const q of qs.slice(0, 2)) found.push(item(q, last, q, 'user_committed'));
    if (found.length === 0) {
      const s = firstSentence(last.content, 200);
      if (s.length >= 12) found.push(item(`Awaiting a reply: ${s}`, last, s.replace(/…$/, ''), 'user_committed', 'inferred'));
    }
  } else {
    const match = stripCode(last.content).match(ASSISTANT_QUESTION_RE);
    if (match) {
      const q = normalizeSpace(match[0]);
      found.push(item(q, last, q, 'assistant_suggested'));
    }
  }
  return found.filter((f) => f.evidenceQuote.length >= 12);
}

// ---------------------------------------------------------------------------------------------
// Coding-agent runs
// ---------------------------------------------------------------------------------------------

const MAX_FILES = 15;
const MAX_COMMANDS = 8;
const MAX_PULL_REQUESTS = 5;
const EDIT_TOOL_RE = /^(?:edit|write|multiedit|notebookedit|apply_patch|applypatch|str_replace_editor|str_replace_based_edit_tool|create_file|edit_file|write_file)$/i;
const SHELL_TOOL_RE = /^(?:bash|shell|sh|zsh|exec|exec_command|local_shell|run_command|run_terminal_cmd|terminal|powershell)$/i;
const PATCH_FILE_RE = /^\*{3}\s*(?:Update|Add|Delete) File:\s*(.+?)\s*$/gm;
const TEST_COMMAND_RE =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::\S+)?|vitest|jest|pytest|mocha|rspec|phpunit|go\s+test|cargo\s+(?:nextest|test)|swift\s+test|playwright\s+test|ctest|dotnet\s+test|mvn\s+test|gradle\s+test)\b/i;
const FAILURE_RE =
  /(?:\bexit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))?[:\s]+[1-9]\d*|\bcommand not found\b|\bnpm ERR!|Traceback \(most recent call last\)|^fatal:|\bFAILED\b|^\s*FAIL\b|\b[1-9]\d* (?:tests? )?failed\b|\b[1-9]\d* failing\b|✗|✖)/im;
const PASS_RE = /(?:\b\d+ (?:tests? )?passed\b|\ball tests? pass(?:ed)?\b|\btests? passed\b|\b\d+ passing\b|\bOK\b\s*$|✓)/im;
const PERMISSION_RE =
  /(?:permission (?:denied|required|prompt|request)|requires? (?:your )?(?:approval|permission)|waiting (?:for|on) (?:your )?(?:approval|permission)|approval (?:is )?required|needs? your approval|doesn'?t want to proceed|user (?:denied|rejected|declined)|denied by (?:the )?user|request(?:ed)? permission to)/i;
const CI_WAIT_RE =
  /(?:waiting (?:for|on) (?:ci|checks|the (?:pipeline|build|checks))|\bchecks? (?:are )?(?:still )?(?:pending|running|in progress)|\bci (?:is )?(?:still )?(?:running|pending))/i;
const PR_URL_RE =
  /https:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/[^\s)>\]"'`]+?\/(?:pull|pulls|merge_requests|pull-requests)\/\d+/g;

type AgentEvent =
  | { kind: 'call'; name: string; detail: string }
  | { kind: 'result'; text: string; error: boolean };

/** Split tool messages into calls and results. CLI imports merge consecutive tool records into one message. */
function toolEvents(content: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const line of content.split('\n')) {
    const call = line.match(/^\[tool\]\s+([^:\s]+)(?::\s?(.*))?$/);
    const result = line.match(/^\[tool (result|error)\]\s?(.*)$/);
    if (call) {
      events.push({ kind: 'call', name: call[1], detail: call[2] ?? '' });
    } else if (result) {
      events.push({ kind: 'result', text: result[2], error: result[1] === 'error' });
    } else {
      // Continuation of the previous record (patch bodies, multi-line output).
      const prev = events[events.length - 1];
      if (!prev) continue;
      if (prev.kind === 'call') prev.detail += `\n${line}`;
      else prev.text += `\n${line}`;
    }
  }
  return events;
}

function clipLine(text: string, max: number): string {
  const t = normalizeSpace(text);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function cleanPath(raw: string): string | null {
  const p = raw.trim().replace(/^["'`]|["'`]$/g, '');
  if (!p || p.length > 200 || /[\n\r]/.test(p) || /\s{2,}/.test(p)) return null;
  return p;
}

function pullRequestFromText(raw: string): string | null {
  // GitLab writes merge requests as /group/project/-/merge_requests/N.
  return normalizePullRequestUrl(raw.replace('/-/merge_requests/', '/merge_requests/'));
}

function repositoryFromPullRequest(url: string): string | null {
  const m = url.match(/^https:\/\/[^/]+\/([^/]+)\/([^/]+)\//);
  return m ? normalizeRepository(`${m[1]}/${m[2]}`) : null;
}

/** Open, or merged/closed when the words next to the link say so; never guessed otherwise. */
function pullRequestState(text: string, at: number, length: number): AgentRunFacts['pullRequests'][number]['state'] {
  const around = text.slice(Math.max(0, at - 80), at + length + 80);
  if (/(?:to be|will be|can be|ready to|before|until|not|un|if)\s+(?:merged|closed)/i.test(around)) return 'unknown';
  const m = around.match(/\b(merged|closed)\b/i);
  return m ? (m[1].toLowerCase() as 'merged' | 'closed') : 'unknown';
}

function summarizeTestOutput(text: string, failed: boolean): string | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const counts = /\b\d+ (?:tests? )?(?:passed|passing|failed|failing)\b/i;
  const pick =
    lines.find((l) => counts.test(l)) ?? lines.find((l) => (failed ? FAILURE_RE : PASS_RE).test(l)) ?? (failed ? lines[0] : undefined);
  return pick ? clipLine(pick, 120) : null;
}

/**
 * What a coding-agent run did, read from its tool calls ("[tool] Name: detail"), their results
 * ("[tool result]" / "[tool error]") and the assistant's text. On-device and conservative: a fact
 * that the transcript does not show stays null, empty or 'unknown'. Null for threads that are not
 * agent runs (a chat thread with tool messages only counts when it shows real work).
 */
export function extractAgentFacts(
  conv: Pick<ConversationRecord, 'provider'> &
    Partial<Pick<ConversationRecord, 'repository' | 'gitBranch' | 'agentState' | 'pullRequestUrl'>>,
  messages: MessageRecord[]
): AgentRunFacts | null {
  const sorted = [...messages].sort((a, b) => a.ordinal - b.ordinal);
  const isAgentProvider = providerCategory(conv.provider) === 'coding_agent';
  const hasToolMessages = sorted.some((m) => m.role === 'tool');
  if (!isAgentProvider && !hasToolMessages) return null;

  const files: string[] = [];
  const addFile = (raw: string) => {
    const p = cleanPath(raw);
    if (p && !files.includes(p)) files.push(p);
  };
  const commands: Array<{ command: string; outcome: 'ok' | 'failed' | 'unknown'; isTest: boolean; output: string }> = [];
  const pending: Array<{ command: (typeof commands)[number] | null }> = [];
  const prs = new Map<string, AgentRunFacts['pullRequests'][number]['state']>();
  let repository: string | null = null;
  let remoteRepository: string | null = null;
  let branch: string | null = null;

  const scanText = (text: string) => {
    for (const m of text.matchAll(PATCH_FILE_RE)) addFile(m[1]);
    for (const m of text.matchAll(PR_URL_RE)) {
      const url = pullRequestFromText(m[0]);
      if (!url) continue;
      const state = pullRequestState(text, m.index ?? 0, m[0].length);
      const prev = prs.get(url);
      prs.set(url, state !== 'unknown' || prev === undefined ? state : prev);
    }
    const clone = text.match(/\bgit\s+clone\s+(?:-\S+\s+)*(\S+)/);
    const remote = text.match(/\bgit\s+remote\s+(?:add|set-url)\s+\S+\s+(\S+)/) ?? text.match(/^origin\s+(\S+)\s+\((?:fetch|push)\)/m);
    for (const raw of [clone?.[1], remote?.[1]]) {
      const repo = raw ? normalizeRepository(raw.replace(/^["']|["']$/g, '')) : null;
      if (repo && hasRepositoryOwner(repo)) remoteRepository = repo;
    }
  };

  for (const m of sorted) {
    if (m.role === 'user' || m.role === 'system') continue;
    scanText(m.content);
    if (m.role !== 'tool') continue;
    for (const ev of toolEvents(m.content)) {
      if (ev.kind === 'call') {
        if (EDIT_TOOL_RE.test(ev.name) && !/^\*{3}/m.test(ev.detail)) addFile(ev.detail.split('\n')[0]);
        if (SHELL_TOOL_RE.test(ev.name) && ev.detail.trim()) {
          const command = clipLine(ev.detail.split('\n')[0], 160);
          const entry = { command, outcome: 'unknown' as const, isTest: TEST_COMMAND_RE.test(command), output: '' };
          commands.push(entry);
          pending.push({ command: entry });
          const created = ev.detail.match(/\bgit\s+(?:checkout\s+-[bB]|switch\s+-[cC])\s+(\S+)/);
          if (created) branch = created[1].replace(/^["']|["']$/g, '');
        } else {
          pending.push({ command: null });
        }
        if (pending.length > 12) pending.shift();
      } else {
        const target = pending.shift()?.command;
        if (!target) continue;
        target.output = ev.text;
        target.outcome = ev.error || FAILURE_RE.test(ev.text) ? 'failed' : 'ok';
      }
    }
  }

  const prUrls = new Map<string, AgentRunFacts['pullRequests'][number]['state']>();
  const recorded = normalizePullRequestUrl(conv.pullRequestUrl ?? null);
  if (recorded) prUrls.set(recorded, prs.get(recorded) ?? 'unknown');
  for (const [url, state] of prs) if (!prUrls.has(url)) prUrls.set(url, state);
  const pullRequests = [...prUrls].slice(0, MAX_PULL_REQUESTS).map(([url, state]) => ({ url, state }));

  repository =
    normalizeRepository(conv.repository ?? null) ??
    (pullRequests[0] ? repositoryFromPullRequest(pullRequests[0].url) : null) ??
    remoteRepository;

  const shown = commands.slice(-MAX_COMMANDS).map(({ command, outcome }) => ({ command, outcome }));
  const lastTest = [...commands].reverse().find((c) => c.isTest);
  const tests: AgentRunFacts['tests'] = !lastTest
    ? { status: 'not_run', detail: null }
    : lastTest.outcome === 'failed'
      ? { status: 'failing', detail: summarizeTestOutput(lastTest.output, true) }
      : lastTest.outcome === 'ok'
        ? { status: 'passing', detail: summarizeTestOutput(lastTest.output, false) }
        : { status: 'unknown', detail: null };

  // Only what is still open: after the person's latest message, nothing has been answered yet.
  const lastUserAt = sorted.reduce((at, m, i) => (m.role === 'user' ? i : at), -1);
  const open = sorted.slice(lastUserAt + 1);
  const openText = open.map((m) => m.content).join('\n');
  const lastDialog = [...sorted].reverse().find((m) => m.role === 'user' || m.role === 'assistant');
  const asksQuestion =
    lastDialog?.role === 'assistant' && ASSISTANT_QUESTION_RE.test(stripCode(lastDialog.content).slice(-600)) && open.at(-1) === lastDialog;
  const blockedOn: AgentRunFacts['blockedOn'] = PERMISSION_RE.test(openText)
    ? 'permission'
    : asksQuestion
      ? 'input'
      : CI_WAIT_RE.test(openText)
        ? 'ci'
        : 'none';

  const observed = conv.agentState;
  let runState: AgentRunFacts['runState'] = 'unknown';
  if (observed === 'running') runState = 'running';
  else if (observed === 'waiting_permission' || observed === 'waiting_answer') runState = 'awaiting_user';
  else if (observed === 'failed') runState = 'errored';
  else if (observed === 'turn_complete') runState = 'finished';
  else if (blockedOn === 'permission' || blockedOn === 'input') runState = 'awaiting_user';
  else if (sorted.at(-1)?.role === 'assistant') runState = 'finished';

  const facts: AgentRunFacts = {
    repository,
    branch: conv.gitBranch?.trim() || branch,
    pullRequests,
    filesChanged: files.slice(0, MAX_FILES),
    commandsRun: shown,
    tests,
    blockedOn,
    runState,
  };
  if (!isAgentProvider && !facts.repository && !facts.branch && !facts.filesChanged.length && !facts.commandsRun.length && !facts.pullRequests.length) {
    return null;
  }
  return facts;
}

/** Why the run needs the person, or null. Names what is waiting. */
function agentNeedsYouReason(conv: Pick<ConversationRecord, 'provider' | 'agentState'>, agent: AgentRunFacts): string | null {
  const who = providerLabel(conv.provider);
  if (conv.agentState === 'waiting_permission') return `${who} is waiting for your approval`;
  if (conv.agentState === 'waiting_answer') return `${who} is waiting on your answer`;
  if (conv.agentState === 'failed') return `${who} run failed (${AGENT_STATE_LABELS.failed.toLowerCase()})`;
  if (agentStateNeedsYou(conv.agentState)) return `${who} needs you`;
  if (agent.blockedOn === 'permission') return `${who} is waiting for your approval`;
  if (agent.blockedOn === 'input') return `${who} is waiting on your answer`;
  return null;
}

function suggestStatus(
  conv: ConversationRecord,
  messages: MessageRecord[],
  nowMs: number,
  agent: AgentRunFacts | null = null
): { status: WorkflowState | null; reason: string | null } {
  const dialog = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (dialog.length === 0) {
    const reason = agent ? agentNeedsYouReason(conv, agent) : null;
    return reason ? { status: 'needs_review', reason } : { status: null, reason: null };
  }
  const last = dialog[dialog.length - 1];
  const lastUser = [...dialog].reverse().find((m) => m.role === 'user');
  const updatedMs = Date.parse(conv.updatedAt ?? conv.lastCapturedAt ?? '');
  const ageDays = Number.isFinite(updatedMs) ? (nowMs - updatedMs) / 86_400_000 : 0;

  if (lastUser && lastUser === dialog[dialog.length - 2] && isClosingMessage(lastUser.content)) {
    return { status: 'done', reason: 'You closed the thread out ("' + firstSentence(lastUser.content, 60) + '")' };
  }
  if (last.role === 'user' && isClosingMessage(last.content)) {
    return { status: 'done', reason: 'Last message wraps the thread up' };
  }
  if (ageDays > 30) {
    return { status: 'paused', reason: `No activity for ${Math.round(ageDays)} days` };
  }
  if (agent) {
    // A stale observation says nothing about now; the age rule above has already handled long silence.
    const reason = agentNeedsYouReason(conv, agent);
    if (reason) return { status: 'needs_review', reason };
    if (agent.runState === 'finished' && agent.pullRequests.some((p) => p.state === 'open' || p.state === 'unknown')) {
      return { status: 'needs_review', reason: 'Pull request is open for review' };
    }
  }
  if (last.role === 'assistant' && ASSISTANT_QUESTION_RE.test(stripCode(last.content).slice(-600))) {
    return { status: 'needs_review', reason: `${providerLabel(conv.provider)} is waiting on your answer` };
  }
  if (agent?.tests.status === 'failing') {
    return { status: 'active', reason: 'Tests are failing and no later run fixed them' };
  }
  return { status: 'active', reason: last.role === 'user' ? 'Your last message has no reply yet' : 'Recently active' };
}

function endSentence(text: string): string {
  return /[.!?…"”]$/.test(text) ? text : `${text}.`;
}

/**
 * One on-device overview paragraph from the opening request, the latest exchange and the topics. Cheap
 * and deterministic; Claude's analysis replaces it with a real narrative.
 */
function localOverview(
  conv: ConversationRecord,
  userMsgs: MessageRecord[],
  lastUser: MessageRecord | undefined,
  lastAssistant: MessageRecord | undefined,
  topics: string[]
): string {
  const parts: string[] = [];
  const opening = userMsgs[0] ? firstSentence(userMsgs[0].content, 180) : '';
  if (opening) parts.push(`You opened with: "${opening.replace(/[.!?]+$/, '')}".`);
  if (lastUser && lastUser !== userMsgs[0]) {
    const latest = firstSentence(lastUser.content, 160);
    if (latest) parts.push(`Most recently you asked: "${latest.replace(/[.!?]+$/, '')}".`);
  }
  if (lastAssistant) {
    const reply = firstSentence(lastAssistant.content, 180);
    if (reply) parts.push(`The latest ${providerLabel(conv.provider)} reply: ${endSentence(reply)}`);
  }
  if (topics.length > 0) parts.push(`Covers ${topics.slice(0, 5).join(', ')}.`);
  return parts.join(' ');
}

export interface LocalAnalysisResult {
  insight: ThreadInsight;
  summary: ExtensionSummaryOutput | null;
}

/** Fast, deterministic, on-device analysis. Never calls the network. */
export function analyzeThreadLocally(
  conv: ConversationRecord,
  messages: MessageRecord[],
  options: { nowMs?: number } = {}
): LocalAnalysisResult {
  const nowMs = options.nowMs ?? Date.now();
  const sorted = [...messages].sort((a, b) => a.ordinal - b.ordinal);
  const dialog = sorted.filter((m) => m.role === 'user' || m.role === 'assistant');
  const userMsgs = dialog.filter((m) => m.role === 'user');
  const lastUser = userMsgs[userMsgs.length - 1];
  const lastAssistant = [...dialog].reverse().find((m) => m.role === 'assistant');
  const displayTitle = getDisplayTitle(conv);

  const gist =
    deriveGist(userMsgs[0]?.content ?? '') ||
    (isGenericTitle(displayTitle) ? '' : displayTitle) ||
    'No message text captured yet';
  const title = isGenericTitle(displayTitle)
    ? (gist.length > 70 ? `${gist.slice(0, 69).trimEnd()}…` : gist) || displayTitle
    : displayTitle;

  const weighted = [
    { text: displayTitle, weight: 4 },
    ...userMsgs.slice(0, 12).map((m, i) => ({ text: m.content.slice(0, 4000), weight: i === 0 ? 3 : 2 })),
    ...dialog
      .filter((m) => m.role === 'assistant')
      .slice(0, 12)
      .map((m) => ({ text: m.content.slice(0, 3000), weight: 0.6 })),
  ];
  const keyTerms = extractKeyTerms(weighted, 8);
  const allText = [displayTitle, ...dialog.map((m) => m.content.slice(0, 6000))].join('\n');
  const tech = detectTechnologies(allText);
  const languages = detectLanguages(sorted);
  const topics = Array.from(
    new Set([...tech.slice(0, 4), ...keyTerms.map((t) => t.replace(/\s+/g, '-'))])
  ).slice(0, 8);
  const kind = classifyKind(conv, displayTitle, sorted);
  const agentRun = extractAgentFacts(conv, sorted);
  const status = suggestStatus(conv, sorted, nowMs, agentRun);
  const lastUserAsk = lastUser ? firstSentence(lastUser.content, 180) : null;

  const overviewParagraph = localOverview(conv, userMsgs, lastUser, lastAssistant, topics);

  const insight: ThreadInsight = {
    insightKey: insightKeyFor('local', conv.threadKey),
    threadKey: conv.threadKey,
    source: 'local',
    model: LOCAL_ANALYZER_MODEL,
    sourceRevision: conv.sourceRevision,
    contentHash: conv.contentHash,
    generatedAt: new Date(nowMs).toISOString(),
    title,
    gist,
    summary: overviewParagraph || 'Only the title has been captured so far.',
    overview: overviewParagraph ? [overviewParagraph] : [],
    userGoal: userMsgs[0] ? firstSentence(userMsgs[0].content, 220) : null,
    outcome:
      status.status === 'done' && lastAssistant ? firstSentence(lastAssistant.content, 220) : null,
    kind,
    topics,
    entities: detectEntities(sorted, displayTitle),
    languages,
    artifacts: detectArtifacts(sorted),
    lastUserAsk,
    suggestedStatus: status.status,
    statusReason: status.reason,
    suggestedProject: null,
    userTurns: userMsgs.length,
    hasCode: sorted.some((m) => m.hasCode && /```/.test(m.content)),
    ...(agentRun ? { agentRun } : {}),
  };

  if (dialog.length === 0) {
    return { insight, summary: null };
  }

  const last = dialog[dialog.length - 1];
  const whereYouLeftOff =
    last.role === 'user'
      ? `You asked "${firstSentence(last.content, 150)}" — no reply captured yet.`
      : lastUserAsk
        ? `You asked "${firstSentence(lastUser!.content, 110)}"; ${providerLabel(conv.provider)} replied: ${firstSentence(last.content, 160)}`
        : `${providerLabel(conv.provider)} replied: ${firstSentence(last.content, 180)}`;

  const summary: ExtensionSummaryOutput = {
    whereYouLeftOff,
    whereYouLeftOffMessageIndexes: [last.ordinal],
    currentStatus: status.reason ?? 'Captured conversation',
    currentStatusMessageIndexes: [last.ordinal],
    decisions: extractDecisions(dialog),
    openQuestions: extractOpenQuestions(dialog),
    actionItems: extractActionItems(dialog),
    constraints: [],
    entities: insight.entities,
    artifactReferences: insight.artifacts.map((a) => a.label),
    suggestedProject: null,
    suggestedTags: topics,
    confidence: 0.45,
  };
  return { insight, summary: sanitizeSummaryForGrounding(summary, sorted) };
}

/**
 * Drop any extracted item that would fail the strict grounding verifier
 * (quote not found, wrong speaker, injection-like text) instead of rejecting
 * the whole summary.
 */
export function sanitizeSummaryForGrounding(
  summary: ExtensionSummaryOutput,
  messages: Array<Pick<MessageRecord, 'ordinal' | 'role' | 'content'>>
): ExtensionSummaryOutput {
  const byOrdinal = new Map(messages.map((m) => [m.ordinal, m]));
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const keep = (it: ExtractedItem): ExtractedItem | null => {
    if (containsPromptInjectionAttempt(it.text)) return null;
    const quote = norm(it.evidenceQuote);
    if (quote.length < 12) return null;
    const idx = it.messageIndexes.find((i) => {
      const m = byOrdinal.get(i);
      return m && norm(m.content).includes(quote);
    });
    let resolved = idx;
    if (resolved === undefined) {
      const owner = messages.find((m) => norm(m.content).includes(quote));
      if (!owner) return null;
      resolved = owner.ordinal;
    }
    const msg = byOrdinal.get(resolved)!;
    const speaker = it.speaker === 'user_committed' && msg.role !== 'user' ? 'assistant_suggested' : it.speaker;
    const kept: ExtractedItem = { ...it, messageIndexes: [resolved], speaker };
    // A rationale is commentary, not evidence: drop it (not the item) when it reads like an instruction.
    if (typeof it.rationale === 'string' && containsPromptInjectionAttempt(it.rationale)) kept.rationale = null;
    return kept;
  };
  const clean = (items: ExtractedItem[]) => items.map(keep).filter((x): x is ExtractedItem => x !== null);
  const validIdx = (idxs: number[]) => idxs.filter((i) => byOrdinal.has(i));
  const lastOrdinal = messages.length > 0 ? messages[messages.length - 1].ordinal : 0;
  const leftOff = validIdx(summary.whereYouLeftOffMessageIndexes);
  const status = validIdx(summary.currentStatusMessageIndexes);
  return {
    ...summary,
    whereYouLeftOff: containsPromptInjectionAttempt(summary.whereYouLeftOff)
      ? 'Summary withheld: the latest turn contains instruction-like text.'
      : summary.whereYouLeftOff,
    whereYouLeftOffMessageIndexes: leftOff.length > 0 ? leftOff : [lastOrdinal],
    currentStatus: containsPromptInjectionAttempt(summary.currentStatus)
      ? 'Status withheld: contains instruction-like text.'
      : summary.currentStatus,
    currentStatusMessageIndexes: status.length > 0 ? status : [lastOrdinal],
    decisions: clean(summary.decisions),
    openQuestions: clean(summary.openQuestions),
    actionItems: clean(summary.actionItems),
    constraints: clean(summary.constraints),
    ...(summary.keyPoints !== undefined ? { keyPoints: clean(summary.keyPoints) } : {}),
    ...(summary.nextStep !== undefined
      ? {
          nextStep:
            typeof summary.nextStep === 'string' && summary.nextStep.trim() && !containsPromptInjectionAttempt(summary.nextStep)
              ? summary.nextStep.trim()
              : null,
        }
      : {}),
  };
}

/**
 * The insight to display: a current AI insight wins; a stale AI insight still
 * supplies the narrative fields while the fresh local pass supplies the
 * latest-turn details; otherwise the local insight.
 */
export function resolveInsight(
  conv: ConversationRecord,
  local: ThreadInsight | undefined,
  ai: ThreadInsight | undefined
): ThreadInsight | null {
  // The AI's reading of the run wins; the on-device facts fill in when it has none (an older
  // analysis, or Claude judged the thread not to be an agent session).
  const agentRun = ai?.agentRun ?? local?.agentRun;
  if (ai && ai.sourceRevision === conv.sourceRevision) {
    return agentRun && !ai.agentRun ? { ...ai, agentRun } : ai;
  }
  if (ai && local) {
    return {
      ...ai,
      lastUserAsk: local.lastUserAsk,
      suggestedStatus: local.suggestedStatus ?? ai.suggestedStatus,
      statusReason: local.statusReason ?? ai.statusReason,
      sourceRevision: local.sourceRevision,
      ...(agentRun ? { agentRun } : {}),
    };
  }
  return ai ?? local ?? null;
}

/**
 * A "title" that is really the user's opening message (sites without titles,
 * CLI sessions without a summary): long, sentence-like or a question.
 */
export function looksLikeRawMessage(title: string): boolean {
  const t = normalizeSpace(title);
  return t.length >= 60 || /[?]$/.test(t) || t.split(' ').length >= 10 || /^[a-z]/.test(t);
}

/** Provider titles stay authoritative unless they are generic ("New chat") or just the opening message. */
export function getSmartTitle(conv: ConversationRecord, insight: ThreadInsight | null): string {
  if (conv.manualTitleOverride?.trim()) return conv.manualTitleOverride.trim();
  if (!insight?.title) return conv.title;
  if (isGenericTitle(conv.title)) return insight.title;
  if (insight.source === 'ai' && looksLikeRawMessage(conv.title)) return insight.title;
  return conv.title;
}
