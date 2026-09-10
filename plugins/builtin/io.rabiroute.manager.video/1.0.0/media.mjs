import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

export async function streamMedia(request, response, file, mime, filename) {
  const { size } = await fs.stat(file);
  const range = request.headers.range;
  let start = 0, end = size - 1;
  if (range) {
    const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
    const suffix = parsed && !parsed[1];
    if (parsed && (parsed[1] || parsed[2])) {
      start = suffix ? Math.max(0, size - Number(parsed[2])) : Number(parsed[1]);
      end = suffix || !parsed[2] ? size - 1 : Math.min(Number(parsed[2]), size - 1);
    } else start = size;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      response.writeHead(416, { "content-range": `bytes */${size}` }); response.end(); return;
    }
  }
  response.writeHead(range ? 206 : 200, {
    "content-type": mime, "content-length": end - start + 1,
    "accept-ranges": "bytes", "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    ...(filename ? { "content-disposition": `inline; filename="${filename}"` } : {}),
    ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {})
  });
  await pipeline(createReadStream(file, { start, end }), response);
}
