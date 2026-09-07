import http from "node:http";
import path from "node:path";
import { RabiDirectVideo } from "../src/manager/rabiDirectVideo.js";

// Isolated acceptance receiver. USB reverse carries SDP only; ICE media uses the network.
const directory = path.resolve(process.argv[2] || "apps/rabilink-android/out/direct-video");
const video = new RabiDirectVideo(directory);
const server = http.createServer(async (request, response) => {
  response.setHeader("connection", "close");
  response.setHeader("content-type", "application/json");
  if (request.method === "GET" && request.url === "/status") {
    response.end(JSON.stringify(video.status())); return;
  }
  if (request.method !== "POST" || request.url !== "/offer") { response.writeHead(404).end(); return; }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length <= 65536) chunks.push(Buffer.from(chunk));
  }
  if (length > 65536) { response.writeHead(413).end(); return; }
  try {
    const result = await video.offer(JSON.parse(Buffer.concat(chunks).toString()));
    const body = JSON.stringify(result);
    response.writeHead(200, { "content-length": Buffer.byteLength(body) }).end(body);
    process.stdout.write(JSON.stringify({ event: "video_answer", sessionId: result.sessionId }) + "\n");
  } catch {
    response.writeHead(400).end(JSON.stringify({ error: "Video negotiation failed" }));
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(JSON.stringify({ event: "READY", signalUrl: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, directory }) + "\n");
});
const stop = async () => { server.close(); await video.stop(); };
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
setTimeout(() => void stop(), 15 * 60 * 1000).unref();
