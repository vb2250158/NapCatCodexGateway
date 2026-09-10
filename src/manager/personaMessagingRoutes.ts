import { errorResponsePresentation } from "../shared/errorPresentation.js";
import http from "node:http";
import path from "node:path";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { routeRuntimeParts, sanitizeRoleId } from "../shared/routeIdentity.js";
import type {
  RolePanelAttachment,
  RolePanelTimelineAppendResult,
  RolePanelTimelineMessage
} from "../rolePanelTimeline.js";
import type { PersonaMessageReplyContext } from "../shared/rolePanelMessage.js";
import {
  executeDurableDelivery,
  normalizeDurableDeliveryId,
  readDurableDeliveryReceipt
} from "./durableDeliveryIdempotency.js";
import type { RouteCatalogPersonaPresentation } from "./routeCatalogTransaction.js";
import { deliverRolePanelMessage, RolePanelDeliveryError } from "./rolePanelDelivery.js";
import type { GatewayRuntime } from "./runtimeRegistry.js";

export type PersonaMessagingRuntime = GatewayRuntime;

export type PersonaMessageDelivery = (
  runtime: PersonaMessagingRuntime,
  messageId: string,
  text: string,
  attachments: RolePanelAttachment[],
  replyContext: Record<string, unknown>
) => Promise<void>;

export type PersonaMessagingRouteContext = {
  rootDir: string;
  rolesRoot: string;
  personaPresentations: () => readonly RouteCatalogPersonaPresentation[];
  runtimes: () => PersonaMessagingRuntime[];
  authorizeSource: (routeId: string, personaId: string, capability: string) => boolean;
  deliver: PersonaMessageDelivery;
  appendTimeline: (roleId: string, message: RolePanelTimelineMessage) => Promise<RolePanelTimelineAppendResult>;
};

export type PersonaRouteSummary = {
  routeId: string;
  name: string;
  enabled: boolean;
  running: boolean;
};

export type PersonaSummary = {
  personaId: string;
  name: string;
  title: string;
  addressable: boolean;
  defaultRouteId?: string;
  routes: PersonaRouteSummary[];
};

type PersonaMessageRequest = {
  deliveryId?: string;
  sourceRouteId?: string;
  sourceCapability?: string;
  targetRouteId?: string;
  conversationId?: string;
  inReplyToMessageId?: string;
  hopCount?: number;
  text?: string;
};

type PreparedPersonaMessage = {
  sourceRouteId: string;
  sourcePersonaId: string;
  sourcePersona: PersonaSummary;
  targetPersonaId: string;
  target: PersonaMessagingRuntime;
  conversationId: string;
  inReplyToMessageId?: string;
  hopCount: number;
  text: string;
};

const MAX_PERSONA_MESSAGE_HOPS = 8;

class PersonaMessagingError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  body = errorResponsePresentation(body, statusCode);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function statusCodeForError(error: unknown): number {
  if (error instanceof PersonaMessagingError) return error.statusCode;
  if (error instanceof SyntaxError) return 400;
  return 500;
}

function readJsonBody<T>(request: http.IncomingMessage, maxBytes: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(buffer);
    });
    request.on("end", () => {
      try {
        if (tooLarge) throw new PersonaMessagingError(413, `Request body exceeds ${maxBytes} bytes.`);
        const text = Buffer.concat(chunks).toString("utf8");
        resolve((text ? JSON.parse(text) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function personaIdForDefinition(definition: GatewayDefinition): string {
  return sanitizeRoleId(definition.agentRoleId) || routeRuntimeParts(definition.id).roleId || "Rabi";
}

function routeSummary(runtime: PersonaMessagingRuntime): PersonaRouteSummary {
  return {
    routeId: runtime.definition.id,
    name: String(runtime.definition.routeName || runtime.definition.name || runtime.definition.id),
    enabled: runtime.definition.enabled === true,
    running: Boolean(runtime.process)
  };
}

function rolesRootKey(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}

export function listPersonas(context: Pick<PersonaMessagingRouteContext, "rolesRoot" | "runtimes" | "personaPresentations">): PersonaSummary[] {
  const runtimes = context.runtimes();
  const activeRoot = rolesRootKey(context.rolesRoot);
  return context.personaPresentations()
    .filter(item => item.isPersona && rolesRootKey(item.rolesRoot) === activeRoot)
    .map((item) => {
      const personaId = item.roleId;
      const title = item.files.find(file => file.fileName.toLowerCase() === "persona.md")?.title ?? "";
      const matchingRuntimes = runtimes.filter(runtime => personaIdForDefinition(runtime.definition) === personaId);
      const routes = matchingRuntimes.map(routeSummary)
        .sort((left, right) => left.routeId.localeCompare(right.routeId));
      const enabledRoutes = routes.filter(route => route.enabled);
      return {
        personaId,
        name: title || routes[0]?.name || item.displayName || personaId,
        title,
        addressable: enabledRoutes.length > 0,
        defaultRouteId: enabledRoutes.length === 1 ? enabledRoutes[0].routeId : undefined,
        routes
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function resolvePersona(personaId: string, personas: PersonaSummary[]): PersonaSummary {
  const persona = personas.find(item => item.personaId === personaId);
  if (!persona) throw new PersonaMessagingError(404, `Persona not found: ${personaId}`);
  return persona;
}

function enabledRuntime(routeId: string, context: PersonaMessagingRouteContext): PersonaMessagingRuntime {
  const runtime = context.runtimes().find(item => item.definition.id === routeId);
  if (!runtime) throw new PersonaMessagingError(404, `Route not found: ${routeId}`);
  if (runtime.definition.enabled !== true) throw new PersonaMessagingError(409, `Route is not enabled: ${routeId}`);
  return runtime;
}

function targetRuntime(
  persona: PersonaSummary,
  targetRouteId: string,
  context: PersonaMessagingRouteContext
): PersonaMessagingRuntime {
  const enabledRoutes = persona.routes.filter(route => route.enabled);
  if (enabledRoutes.length === 0) {
    throw new PersonaMessagingError(409, `Persona has no enabled Route: ${persona.personaId}`);
  }
  if (!targetRouteId && enabledRoutes.length > 1) {
    throw new PersonaMessagingError(409, `Persona has multiple enabled Routes; provide targetRouteId: ${persona.personaId}`);
  }
  const routeId = targetRouteId || enabledRoutes[0].routeId;
  if (!enabledRoutes.some(route => route.routeId === routeId)) {
    throw new PersonaMessagingError(409, `Route is not an enabled target for persona ${persona.personaId}: ${routeId}`);
  }
  return enabledRuntime(routeId, context);
}

function preparePersonaMessage(
  targetPersonaId: string,
  body: PersonaMessageRequest,
  context: PersonaMessagingRouteContext
): PreparedPersonaMessage {
  const sourceRouteId = String(body.sourceRouteId || "").trim();
  if (!sourceRouteId) throw new PersonaMessagingError(400, "Missing sourceRouteId.");
  const sourceRuntime = enabledRuntime(sourceRouteId, context);
  const sourcePersonaId = personaIdForDefinition(sourceRuntime.definition);
  const sourceCapability = String(body.sourceCapability || "").trim();
  if (!sourceCapability || !context.authorizeSource(sourceRouteId, sourcePersonaId, sourceCapability)) {
    throw new PersonaMessagingError(403, "The source Route capability is missing or invalid.");
  }
  const personas = listPersonas(context);
  const sourcePersona = resolvePersona(sourcePersonaId, personas);
  const targetPersona = resolvePersona(targetPersonaId, personas);
  if (sourcePersonaId === targetPersonaId) {
    throw new PersonaMessagingError(409, "Cross-persona messaging cannot target the source persona.");
  }

  const text = String(body.text || "").trim();
  if (!text) throw new PersonaMessagingError(400, "Missing message text.");
  if (text.length > 32_768) throw new PersonaMessagingError(413, "Message text exceeds 32768 characters.");
  const target = targetRuntime(targetPersona, String(body.targetRouteId || "").trim(), context);
  const conversationId = String(body.conversationId || "").trim() || `persona:${normalizeDurableDeliveryId(body.deliveryId)}`;
  if (conversationId.length > 200) throw new PersonaMessagingError(400, "conversationId exceeds 200 characters.");
  const inReplyToMessageId = String(body.inReplyToMessageId || "").trim() || undefined;
  if (inReplyToMessageId && inReplyToMessageId.length > 200) {
    throw new PersonaMessagingError(400, "inReplyToMessageId exceeds 200 characters.");
  }
  const hopCount = body.hopCount == null ? 0 : Number(body.hopCount);
  if (!Number.isInteger(hopCount) || hopCount < 0) throw new PersonaMessagingError(400, "hopCount must be a non-negative integer.");
  if (hopCount > MAX_PERSONA_MESSAGE_HOPS) {
    throw new PersonaMessagingError(409, `Cross-persona message hopCount exceeds ${MAX_PERSONA_MESSAGE_HOPS}.`);
  }
  return {
    sourceRouteId,
    sourcePersonaId,
    sourcePersona,
    targetPersonaId,
    target,
    conversationId,
    inReplyToMessageId,
    hopCount,
    text
  };
}

async function deliverPersonaMessage(
  prepared: PreparedPersonaMessage,
  context: PersonaMessagingRouteContext
): Promise<Record<string, unknown>> {
  const {
    sourceRouteId,
    sourcePersonaId,
    sourcePersona,
    targetPersonaId,
    target,
    conversationId,
    inReplyToMessageId,
    hopCount,
    text
  } = prepared;
  const personaReplyContext: PersonaMessageReplyContext = {
    crossPersona: true,
    sourcePersonaId,
    sourcePersonaName: sourcePersona.name,
    sourceRouteId,
    targetPersonaId,
    targetRouteId: target.definition.id,
    personaConversationId: conversationId,
    inReplyToPersonaMessageId: inReplyToMessageId,
    personaMessageHopCount: hopCount,
    personaMessageMaxHops: MAX_PERSONA_MESSAGE_HOPS
  };
  try {
    const delivery = await deliverRolePanelMessage({
      runtime: target,
      roleId: targetPersonaId,
      sender: sourcePersona.name,
      text,
      attachments: [],
      messageIdPrefix: "persona-message",
      replyContext: personaReplyContext,
      deliver: context.deliver,
      appendTimeline: context.appendTimeline
    });
    return {
      status: delivery.status,
      sourcePersonaId,
      sourceRouteId,
      targetPersonaId,
      targetRouteId: target.definition.id,
      conversationId,
      hopCount,
      timelineRecorded: delivery.timelineRecorded,
      message: delivery.message
    };
  } catch (error) {
    if (error instanceof RolePanelDeliveryError) throw new PersonaMessagingError(error.statusCode, error.message);
    throw error;
  }
}

export function handlePersonaMessagingApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  context: PersonaMessagingRouteContext
): boolean {
  if (request.method === "GET" && requestUrl.pathname === "/api/personas") {
    try {
      const addressableOnly = requestUrl.searchParams.get("addressable") === "true";
      const personas = listPersonas(context).filter(persona => !addressableOnly || persona.addressable);
      jsonResponse(response, 200, { code: 0, personas });
    } catch (error) {
      jsonResponse(response, statusCodeForError(error), {
        code: -1,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return true;
  }

  const receiptMatch = requestUrl.pathname.match(/^\/api\/personas\/messages\/receipts\/([^/]+)$/);
  if (request.method === "GET" && receiptMatch) {
    try {
      const deliveryId = normalizeDurableDeliveryId(decodeURIComponent(receiptMatch[1]));
      const receipt = readDurableDeliveryReceipt<Record<string, unknown>>(
        context.rootDir,
        "persona-message-idempotency",
        deliveryId
      );
      if (!receipt) jsonResponse(response, 404, { code: -1, message: "Persona message receipt was not found." });
      else jsonResponse(response, 200, { code: 0, receipt });
    } catch (error) {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  const match = requestUrl.pathname.match(/^\/api\/personas\/([^/]+)(\/messages)?$/);
  if (!match) return false;
  let personaId = "";
  try { personaId = sanitizeRoleId(decodeURIComponent(match[1])); } catch { /* invalid encoding */ }
  if (!personaId) {
    jsonResponse(response, 400, { code: -1, message: "Invalid persona id." });
    return true;
  }

  if (request.method === "GET" && !match[2]) {
    try {
      jsonResponse(response, 200, { code: 0, persona: resolvePersona(personaId, listPersonas(context)) });
    } catch (error) {
      jsonResponse(response, statusCodeForError(error), { code: -1, message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (request.method === "POST" && match[2]) {
    void readJsonBody<PersonaMessageRequest>(request, 65_536)
      .then(async (body) => {
        let deliveryId = "";
        try {
          deliveryId = normalizeDurableDeliveryId(body.deliveryId);
        } catch (error) {
          throw new PersonaMessagingError(400, error instanceof Error ? error.message : String(error));
        }
        const prepared = preparePersonaMessage(personaId, body, context);
        const outcome = await executeDurableDelivery({
          rootDir: context.rootDir,
          namespace: "persona-message-idempotency",
          deliveryId,
          payload: {
            sourceRouteId: prepared.sourceRouteId,
            targetPersonaId: prepared.targetPersonaId,
            targetRouteId: prepared.target.definition.id,
            conversationId: prepared.conversationId,
            inReplyToMessageId: prepared.inReplyToMessageId,
            hopCount: prepared.hopCount,
            text: prepared.text
          },
          deliver: async () => {
            try {
              return await deliverPersonaMessage(prepared, context);
            } catch (error) {
              if (error instanceof PersonaMessagingError) {
                return { status: "failed", statusCode: error.statusCode, message: error.message };
              }
              throw error;
            }
          }
        });
        if (outcome.state === "completed") {
          const deliveryFailed = outcome.result.status === "failed";
          return {
            statusCode: deliveryFailed ? Number(outcome.result.statusCode || 502) : 202,
            body: {
              code: deliveryFailed ? -1 : 0,
              ...outcome.result,
              idempotency: { deliveryId, state: "completed", duplicate: outcome.duplicate }
            }
          };
        }
        return {
          statusCode: outcome.state === "uncertain" ? 503 : 409,
          body: {
            code: -1,
            status: "failed",
            message: outcome.reason,
            idempotency: { deliveryId, state: outcome.state, duplicate: true }
          }
        };
      })
      .then(result => jsonResponse(response, result.statusCode, result.body))
      .catch((error) => {
        jsonResponse(response, statusCodeForError(error), { code: -1, status: "failed", message: error instanceof Error ? error.message : String(error) });
      });
    return true;
  }

  jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
  return true;
}
