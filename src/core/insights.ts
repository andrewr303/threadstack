import { providerLabel } from './providers.js';
import {
  THREAD_KINDS,
  computeDeterministicHash,
  getDisplayTitle,
  insightKeyFor,
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

export const LOCAL_ANALYZER_MODEL = 'local-heuristics-v2';

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
  if (conv.provider === 'claude_code' || conv.provider === 'codex') {
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

function suggestStatus(
  conv: ConversationRecord,
  messages: MessageRecord[],
  nowMs: number
): { status: WorkflowState | null; reason: string | null } {
  const dialog = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (dialog.length === 0) return { status: null, reason: null };
  const last = dialog[dialog.length - 1];
  const lastUser = [...dialog].reverse().find((m) => m.role === 'user');
  const updatedMs = Date.parse(conv.updatedAt ?? conv.lastCapturedAt ?? '');
  const ageDays = Number.isFinite(updatedMs) ? (nowMs - updatedMs) / 86_400_000 : 0;

  if (lastUser && lastUser === dialog[dialog.length - 2] && CLOSING_RE.test(lastUser.content) && lastUser.content.length < 160) {
    return { status: 'done', reason: 'You closed the thread out ("' + firstSentence(lastUser.content, 60) + '")' };
  }
  if (last.role === 'user' && CLOSING_RE.test(last.content) && last.content.length < 160) {
    return { status: 'done', reason: 'Last message wraps the thread up' };
  }
  if (ageDays > 30) {
    return { status: 'paused', reason: `No activity for ${Math.round(ageDays)} days` };
  }
  if (last.role === 'assistant' && ASSISTANT_QUESTION_RE.test(stripCode(last.content).slice(-600))) {
    return { status: 'needs_review', reason: `${providerLabel(conv.provider)} is waiting on your answer` };
  }
  return { status: 'active', reason: last.role === 'user' ? 'Your last message has no reply yet' : 'Recently active' };
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
  const status = suggestStatus(conv, sorted, nowMs);
  const lastUserAsk = lastUser ? firstSentence(lastUser.content, 180) : null;

  const summaryParts: string[] = [];
  if (userMsgs[0]) summaryParts.push(`Started by asking: ${firstSentence(userMsgs[0].content, 180)}`);
  if (lastUser && lastUser !== userMsgs[0]) summaryParts.push(`Most recently: ${lastUserAsk}`);
  if (lastAssistant) summaryParts.push(`Latest reply: ${firstSentence(lastAssistant.content, 180)}`);
  if (topics.length > 0) summaryParts.push(`Covers ${topics.slice(0, 5).join(', ')}.`);

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
    summary: summaryParts.join(' ') || 'Only the title has been captured so far.',
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
    return { ...it, messageIndexes: [resolved], speaker };
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
  if (ai && ai.sourceRevision === conv.sourceRevision) return ai;
  if (ai && local) {
    return {
      ...ai,
      lastUserAsk: local.lastUserAsk,
      suggestedStatus: local.suggestedStatus ?? ai.suggestedStatus,
      statusReason: local.statusReason ?? ai.statusReason,
      sourceRevision: local.sourceRevision,
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

export function insightDocHash(insight: ThreadInsight): string {
  return computeDeterministicHash(
    `${insight.title}|${insight.gist}|${insight.summary}|${insight.topics.join(',')}|${insight.entities.join(',')}`
  );
}
