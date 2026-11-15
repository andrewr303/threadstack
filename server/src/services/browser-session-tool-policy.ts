import type { Db } from "@paperclipai/db";
import { toolAccessPolicyService } from "./tool-access-policy.js";
import { logActivity } from "./activity-log.js";
import { BROWSER_SESSION_READ_POLICY_DESCRIPTION, BROWSER_SESSION_READ_POLICY_NAME, BROWSER_SESSION_READ_TOOLS } from "./browser-session-policy-identity.js";

/** Called only by the first-party plugin's authenticated sharing receipt. */
export async function ensureBrowserSessionReadPolicy(db: Db, companyId: string) {
  const policies = toolAccessPolicyService(db);
  const existing = (await policies.listPolicies(companyId)).find((policy) => policy.name === BROWSER_SESSION_READ_POLICY_NAME);
  // Operator edits and disable choices are authoritative across reconnects.
  if (existing) return existing;
  try {
    const policy = await policies.createPolicy(companyId, { name: BROWSER_SESSION_READ_POLICY_NAME, description: BROWSER_SESSION_READ_POLICY_DESCRIPTION, policyType: "allow", enabled: true, priority: 2147483647, selectors: { actorType: "agent", toolNames: BROWSER_SESSION_READ_TOOLS } });
    await logActivity(db, { companyId, actorType: "plugin", actorId: "browser-sessions", action: "tool_policy.created", entityType: "tool_policy", entityId: policy.id, details: { source: "browser_sessions.sharing_changed", toolNames: BROWSER_SESSION_READ_TOOLS } });
    return policy;
  } catch (error) {
    const concurrent = (await policies.listPolicies(companyId)).find((policy) => policy.name === BROWSER_SESSION_READ_POLICY_NAME);
    if (concurrent) return concurrent;
    throw error;
  }
}
