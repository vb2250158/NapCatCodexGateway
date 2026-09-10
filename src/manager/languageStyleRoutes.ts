import { errorResponsePresentation } from "../shared/errorPresentation.js";
import http from "node:http";
import {
  LanguageStyleValidator,
  type LanguageStyleValidationRequest
} from "../languageStyleValidation.js";

function jsonResponse(response: http.ServerResponse, statusCode: number, body: unknown): void {
  body = errorResponsePresentation(body, statusCode);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function readJsonBody(request: http.IncomingMessage, maximumBytes = 512 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maximumBytes) {
        reject(new Error("Language style validation request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) as Record<string, unknown> : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

export function handleLanguageStyleApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  validator: LanguageStyleValidator
): boolean {
  if (request.method !== "POST" || requestUrl.pathname !== "/api/language-style/validate") return false;
  void readJsonBody(request)
    .then(body => validator.validate(body as LanguageStyleValidationRequest))
    .then(data => jsonResponse(response, 200, { code: 0, data }))
    .catch(error => jsonResponse(response, 400, {
      code: -1,
      message: error instanceof Error ? error.message : String(error)
    }));
  return true;
}
