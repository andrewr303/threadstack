import type { ThreadkeeperDB } from './db.js';
import type { ConversationRecord, SettingsRecord } from './schema.js';

/**
 * The one rule for what may leave this browser. A thread's text, and anything
 * derived from it (gist, excerpts, tags), may go to Claude, an embedding API
 * or a reranker only when the thread is not local-only, not filed in a
 * local-only project, not from an excluded provider and not synthetic.
 */
export function isRemoteAllowed(
  conv: ConversationRecord,
  settings: SettingsRecord,
  localOnlyProjects: ReadonlySet<string>
): boolean {
  if (conv.cloudExcluded || conv.isSyntheticBenchmark) return false;
  if (settings.cloudExcludedProviders.includes(conv.provider)) return false;
  return !localOnlyProjects.has(conv.project);
}

export async function localOnlyProjectNames(db: ThreadkeeperDB): Promise<Set<string>> {
  const collections = await db.collections.toArray();
  return new Set(collections.filter((c) => c.cloudExcluded).map((c) => c.name));
}

/**
 * The subset of `threadKeys` that may be sent, read fresh from the database
 * so a thread or project marked local-only a moment ago is honoured even if
 * the caller's copy is stale.
 */
export async function remoteAllowedKeys(
  db: ThreadkeeperDB,
  settings: SettingsRecord,
  threadKeys: string[]
): Promise<Set<string>> {
  const [convs, localOnly] = await Promise.all([db.conversations.bulkGet(threadKeys), localOnlyProjectNames(db)]);
  const allowed = new Set<string>();
  for (const conv of convs) {
    if (conv && isRemoteAllowed(conv, settings, localOnly)) allowed.add(conv.threadKey);
  }
  return allowed;
}
