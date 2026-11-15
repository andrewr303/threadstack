import type { Db } from "@paperclipai/db";
import { agentApiKeys, companyMemberships, instanceUserRoles, heartbeatRuns, projects } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import { issueActivityChangesTaskIdentity, type LiveEvent } from "@paperclipai/shared";
import { authorizationService, type AuthorizationActor } from "../services/authorization.js";
import { createLiveEventDelivery, sharedDeliveryRead, type LiveDeliveryReads } from "./live-event-delivery.js";
import { skillAccessService } from "../services/skill-access.js";
import { canActorReadCase } from "../services/case-access.js";
import { getHeartbeatRunReadDecisions } from "../services/heartbeat-run-privacy.js";
import { createLiveRunEventRedactor } from "../services/live-run-event-redaction.js";
import { activityToastIdentity } from "./activity-toast-identity.js";
import { taskToastEligible } from "./task-toast-eligibility.js";
import { logger } from "../middleware/logger.js";

export interface CompanyLiveContext {
  actor: AuthorizationActor;
  apiKeyId?: string;
  companyId: string;
  actorType: "board" | "agent";
  actorId: string;
}
export type CompanyLiveSink = Parameters<typeof createLiveEventDelivery>[0]["socket"];

/** One viewer projection and bounded delivery path for both browser transports. */
export function createCompanyLiveDelivery(db: Db, context: CompanyLiveContext, socket: CompanyLiveSink) {
  const redactRunEvent = createLiveRunEventRedactor(db);
  const access = authorizationService(db);
  async function visibleEvent(event: LiveEvent, reads: LiveDeliveryReads): Promise<LiveEvent | null> {
    if (event.payload.entityType === "case" && (typeof event.payload.entityId !== "string"
      || !(await canActorReadCase(db, context!.actor, { id: event.payload.entityId, companyId: event.companyId })))) return null;
    if (context!.actor.source === "local_implicit") {
      if (event.type === "activity.logged" && event.payload.entityType === "issue") {
        return { ...event, payload: { ...event.payload,
          taskIdentityChanged: issueActivityChangesTaskIdentity(event.payload.action, event.payload.details),
          ...await activityToastIdentity(db, event.companyId, event.payload) } };
      }
      return event;
    }
    const principalActive = await sharedDeliveryRead(reads, "principal", async () => {
      if (context!.apiKeyId) {
        const active = await db.select({ id: agentApiKeys.id }).from(agentApiKeys)
          .where(and(eq(agentApiKeys.id, context!.apiKeyId), isNull(agentApiKeys.revokedAt))).limit(1);
        return active.length > 0;
      }
      const membership = await db.select({ id: companyMemberships.id }).from(companyMemberships)
        .where(and(eq(companyMemberships.companyId, context!.companyId), eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, context!.actorId), eq(companyMemberships.status, "active"))).limit(1);
      const admin = context!.actor.source !== "cloud_tenant" && await db.select({ id: instanceUserRoles.id }).from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, context!.actorId), eq(instanceUserRoles.role, "instance_admin"))).limit(1).then(rows => rows.length > 0);
      return membership.length > 0 || admin;
    });
    if (!principalActive) return null;
    const payload = event.payload;
    const issueId = typeof payload.issueId === "string" ? payload.issueId
      : payload.entityType === "issue" && typeof payload.entityId === "string" ? payload.entityId : null;
    const runId = typeof payload.runId === "string" ? payload.runId
      : payload.entityType === "heartbeat_run" && typeof payload.entityId === "string" ? payload.entityId : null;
    if (event.type === "heartbeat.run.event" || event.type === "heartbeat.run.log") {
      const allowed = await sharedDeliveryRead(reads, "transcript-scope", async () => (await access.decide({
        actor: context!.actor, action: "company_scope:read",
        resource: { type: "company", companyId: event.companyId } })).allowed);
      if (!allowed) return null;
    }
    const readBindings: Parameters<typeof getHeartbeatRunReadDecisions>[3][number][] = [];
    if (issueId) {
      readBindings.push({ companyId: event.companyId, scopeKind: "issue", issueId });
    }
    if (runId) {
      const run = await sharedDeliveryRead(reads, `run:${runId}`, async () => (await db.select({
        companyId: heartbeatRuns.companyId,
        scopeKind: heartbeatRuns.scopeKind,
        issueId: heartbeatRuns.issueId,
      }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, event.companyId))))[0]);
      if (!run) return null;
      readBindings.push(run);
    }
    if (!(await sharedDeliveryRead(reads, `read:${issueId ?? ""}:${runId ?? ""}`, async () =>
      (await getHeartbeatRunReadDecisions(db, access, context!.actor, readBindings)).every(Boolean)))) return null;
    if (["company_skill", "company_skill_source"].includes(String(payload.entityType)) && typeof payload.entityId === "string") {
      try {
        const skills = skillAccessService(db, context!.actor);
        if (payload.entityType === "company_skill") await skills.assertSkill(event.companyId, payload.entityId);
        else await skills.assertSource(event.companyId, payload.entityId);
      } catch { return null; }
    }
    if (payload.entityType === "project" && typeof payload.entityId === "string") {
      const [project] = await db.select({ id: projects.id }).from(projects)
        .where(and(eq(projects.id, payload.entityId), eq(projects.companyId, event.companyId))).limit(1);
      if (!project || !(await access.decide({ actor: context!.actor, action: "project:read",
        resource: { type: "project", companyId: event.companyId, projectId: project.id } })).allowed) return null;
    }
    if (event.type.startsWith("heartbeat.run.")) return runId ? event : null;
    if (event.type === "agent.session.goal.changed") return issueId ? event : null;
    // Company-wide invalidations carry no task-derived content. Authorized
    // clients obtain details through viewer-filtered HTTP reads.
    if (event.type === "activity.logged") return { ...event, payload: {
      action: payload.action, entityType: payload.entityType, entityId: payload.entityId,
      // A handoff can attach the first case to a task. Its already-authorized
      // task identity lets an empty cases panel refresh without exposing content.
      ...(payload.entityType === "case" && String(payload.action).startsWith("case.handoff_") && issueId ? { issueId } : {}),
      // A closed boolean derived from details, so task pickers can tell a
      // created, deleted, hidden or renamed task from routine progress.
      ...(payload.entityType === "issue"
        ? { taskIdentityChanged: issueActivityChangesTaskIdentity(payload.action, payload.details) }
        : {}),
      // The task read check above authorizes attribution, but not arbitrary details.
      ...(issueId ? await activityToastIdentity(db, event.companyId, payload) : {}),
    } };
    if (event.type === "agent.status") return { ...event, payload: { agentId: payload.agentId, status: payload.status } };
    if (event.type === "agent.runtime_state.updated") return { ...event, payload: { agentId: payload.agentId } };
    if (event.type === "external_object.updated") return { ...event, payload: { externalObjectId: payload.externalObjectId } };
    if (event.type.startsWith("plugin.")) return event;
    return null;
  }
  return createLiveEventDelivery({ socket, authorize: async (event, reads) => {
    const visible = await visibleEvent(event, reads);
    if (!visible || visible.type !== "heartbeat.run.event") return visible;
    const payload = visible.payload.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("prpEvent" in payload)) return visible;
    return redactRunEvent(visible, reads);
  },
    decorate: async visible => {
      let toastEligible = false;
      try {
        toastEligible = await taskToastEligible(db, visible,
          context.actor.type === "board" ? context.actor.userId ?? null : null);
      } catch (err) { logger.warn({ err, companyId: context.companyId }, "task toast eligibility failed"); }
      return { ...visible, toastEligible };
    },
    onError: err => logger.warn({ err, companyId: context.companyId }, "live event authorization failed"),
  });
}
