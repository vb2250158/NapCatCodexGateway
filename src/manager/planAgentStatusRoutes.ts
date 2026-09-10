import { errorResponsePresentation } from "../shared/errorPresentation.js";
import http from "node:http";
import { getPlan, listPlans, type PlanItem } from "../roleKnowledge.js";
import {
  planAgentStatusService,
  type PlanAgentRole,
  type PlanAgentStatusService
} from "./planAgentStatus.js";

type PlanAgentStatusRouteContext = {
  roleDir: (roleId: string) => string;
  service?: PlanAgentStatusService;
  listPlans?: (roleDir: string) => PlanItem[];
  getPlan?: (roleDir: string, planId: string) => PlanItem | null;
};

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  body = errorResponsePresentation(body, statusCode);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody<T>(request: http.IncomingMessage, maxBytes = 8 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return (text ? JSON.parse(text) : {}) as T;
}

function decode(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`Invalid ${label}.`);
  }
}

export function handlePlanAgentStatusApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: PlanAgentStatusRouteContext
): boolean {
  const statusMatch = requestUrl.pathname.match(/^\/api\/roles\/([^/]+)\/plan-agents\/status$/);
  if (statusMatch) {
    if (request.method !== "GET") return false;
    try {
      const roleId = decode(statusMatch[1] || "", "role id");
      const roleDir = context.roleDir(roleId);
      const requestedIds = new Set(requestUrl.searchParams.getAll("planId").map((value) => value.trim()).filter(Boolean));
      const plans = (context.listPlans ?? listPlans)(roleDir)
        .filter((plan) => requestedIds.size === 0 || requestedIds.has(plan.id));
      const missingPlanIds = requestedIds.size === 0
        ? []
        : [...requestedIds].filter((planId) => !plans.some((plan) => plan.id === planId));
      void (context.service ?? planAgentStatusService).inspectPlans(plans)
        .then((items) => jsonResponse(response, 200, { code: 0, data: { items, missingPlanIds } }))
        .catch((error) => jsonResponse(response, 500, { code: -1, message: error instanceof Error ? error.message : String(error) }));
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  const openMatch = requestUrl.pathname.match(/^\/api\/roles\/([^/]+)\/plan-agents\/([^/]+)\/open$/);
  if (!openMatch) return false;
  if (request.method !== "POST") return false;
  let roleId = "";
  let planId = "";
  try {
    roleId = decode(openMatch[1] || "", "role id");
    planId = decode(openMatch[2] || "", "plan id");
  } catch (error) {
    jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    return true;
  }
  void readJsonBody<{ role?: PlanAgentRole }>(request)
    .then(async (body) => {
      const role = body.role === "secretary" ? "secretary" : body.role === "task" ? "task" : null;
      if (!role) throw new Error("role must be task or secretary.");
      const roleDir = context.roleDir(roleId);
      const plan = (context.getPlan ?? getPlan)(roleDir, planId);
      if (!plan) {
        jsonResponse(response, 404, { code: -1, message: `Plan not found: ${planId}` });
        return;
      }
      const data = await (context.service ?? planAgentStatusService).openPlanAgent(plan, role);
      jsonResponse(response, 202, { code: 0, data });
    })
    .catch((error) => jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
  return true;
}
