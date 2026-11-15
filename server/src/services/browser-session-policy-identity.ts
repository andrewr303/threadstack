/** Narrow identity for the board's shared-session read grant. No action tools. */
export const BROWSER_SESSION_READ_POLICY_NAME = "Threadkeeper shared session read access";
export const BROWSER_SESSION_READ_POLICY_DESCRIPTION = "Created when the board shares browser sessions with this company. Explicit tool restrictions still apply.";
export const BROWSER_SESSION_READ_TOOLS = ["sessions_list", "sessions_search", "session_get", "session_read", "sessions_context", "sessions_related"].map((name) => `browser-sessions:${name}`);
export function isBrowserSessionReadPolicy(policy: { name: string; description: string | null; selectors: Record<string, unknown> }) {
  const names = policy.selectors.toolNames;
  return policy.name === BROWSER_SESSION_READ_POLICY_NAME && policy.description === BROWSER_SESSION_READ_POLICY_DESCRIPTION && policy.selectors.actorType === "agent" && Array.isArray(names) && names.length === BROWSER_SESSION_READ_TOOLS.length && names.every((name) => typeof name === "string" && BROWSER_SESSION_READ_TOOLS.includes(name));
}
