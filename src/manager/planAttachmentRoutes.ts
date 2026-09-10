import { errorResponsePresentation } from "../shared/errorPresentation.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { resolvePlanAttachmentFile } from "../planAttachments.js";
import { getPlan } from "../roleKnowledge.js";
import type { PlanAttachment } from "../shared/planAttachmentContract.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  body = errorResponsePresentation(body, statusCode);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function contentDisposition(attachment: PlanAttachment): string {
  const mode = attachment.kind === "image" || attachment.kind === "video" ? "inline" : "attachment";
  const asciiName = path.basename(attachment.name)
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/["\\]/g, "_") || "attachment";
  return `${mode}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(path.basename(attachment.name))}`;
}

function parseByteRange(value: string | undefined, size: number): { start: number; end: number } | undefined {
  if (!value) return undefined;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2]) || size <= 0) throw new Error("Invalid byte range.");
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new Error("Invalid byte range.");
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    throw new Error("Invalid byte range.");
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export function handlePlanAttachmentApi(
  request: http.IncomingMessage,
  pathname: string,
  response: http.ServerResponse,
  resolveRoleDir: (roleId: string) => string
): boolean {
  const match = pathname.match(/^\/api\/roles\/([^/]+)\/plans\/([^/]+)\/attachments\/([^/]+)$/);
  if (!match) return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    jsonResponse(response, 405, { code: -1, message: "Method not allowed." });
    return true;
  }

  let roleId: string;
  let planId: string;
  let attachmentId: string;
  try {
    roleId = sanitizeRoleId(decodeURIComponent(match[1]));
    planId = decodeURIComponent(match[2]);
    attachmentId = decodeURIComponent(match[3]);
  } catch {
    jsonResponse(response, 400, { code: -1, message: "Invalid plan attachment path." });
    return true;
  }
  if (!roleId || !planId || !attachmentId) {
    jsonResponse(response, 400, { code: -1, message: "Invalid plan attachment path." });
    return true;
  }

  try {
    const roleDir = resolveRoleDir(roleId);
    const plan = getPlan(roleDir, planId);
    const attachment = plan?.attachments.find((item) => item.id === attachmentId);
    if (!plan || !attachment) {
      jsonResponse(response, 404, { code: -1, message: "Plan attachment not found." });
      return true;
    }
    const filePath = resolvePlanAttachmentFile(roleDir, plan.id, attachment);
    const body = fs.readFileSync(filePath);
    let range: { start: number; end: number } | undefined;
    try {
      range = parseByteRange(typeof request.headers?.range === "string" ? request.headers.range : undefined, body.byteLength);
    } catch {
      response.writeHead(416, {
        "content-range": `bytes */${body.byteLength}`,
        "accept-ranges": "bytes",
        "x-content-type-options": "nosniff"
      });
      response.end();
      return true;
    }
    const responseBody = range ? body.subarray(range.start, range.end + 1) : body;
    response.writeHead(range ? 206 : 200, {
      "content-type": attachment.mimeType || "application/octet-stream",
      "content-length": String(responseBody.byteLength),
      "content-disposition": contentDisposition(attachment),
      "cache-control": "private, max-age=3600",
      "accept-ranges": "bytes",
      ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${body.byteLength}` } : {}),
      "x-content-type-options": "nosniff"
    });
    response.end(request.method === "HEAD" ? undefined : responseBody);
  } catch (error) {
    const causeCode = (error as NodeJS.ErrnoException).code;
    const message = error instanceof Error ? error.message : String(error);
    const status = causeCode === "ENOENT" || /not found|unavailable|managed directories/i.test(message) ? 404 : causeCode === "EACCES" || causeCode === "EPERM" ? 403 : 500;
    jsonResponse(response, status, { code: -1, reason: causeCode || "attachment_read_failed",
      message });
  }
  return true;
}
