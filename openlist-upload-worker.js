import { createHash } from "node:crypto";

const RESPONSE_LIMIT = 64 * 1024;
const HARD_BUFFER_LIMIT = 32 * 1024 * 1024;

class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function config(env) {
  function address(value, name) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new UploadError(`Invalid ${name}`, 500);
    }
    return url.href.replace(/\/$/, "");
  }
  const cfg = {
    address: address(env.ADDRESS, "ADDRESS"),
    worker: address(env.WORKER_ADDRESS, "WORKER_ADDRESS"),
    disableSign: env.DISABLE_SIGN === "true" || env.DISABLE_SIGN === true,
    token: env.TOKEN || "",
  };
  if (!cfg.disableSign && !cfg.token) throw new UploadError("TOKEN is required", 500);
  return cfg;
}

function cors(request) {
  return {
    "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
    "Access-Control-Allow-Methods": "PUT, OPTIONS, GET",
    "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "Content-Type, File-Path, X-File-Size, Overwrite",
    "Access-Control-Expose-Headers": "ETag, Location",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
}

function jsonResponse(request, code, message, data = null, status = code) {
  return new Response(JSON.stringify({ code, message, data }), {
    status,
    headers: { ...cors(request), "Content-Type": "application/json;charset=UTF-8" },
  });
}

async function readLimited(body, limit, exactSize) {
  if (!body) {
    if (exactSize > 0) throw new UploadError("Missing upload body");
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks = exactSize === undefined ? [] : null;
  const buffer = exactSize === undefined ? null : new Uint8Array(exactSize);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit || (exactSize !== undefined && total > exactSize)) {
        await reader.cancel();
        throw new UploadError("Upload exceeds authorized size", 413);
      }
      if (buffer) buffer.set(value, total - value.byteLength);
      else chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (exactSize !== undefined && total !== exactSize) throw new UploadError("Upload size mismatch");
  if (buffer) return buffer;
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}

function descriptor(request, cfg) {
  const url = new URL(request.url);
  let req;
  const payload = url.searchParams.get("payload");
  if (payload) {
    if (payload.length > 16384) throw new UploadError("Upload descriptor too large");
    try {
      const bytes = Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
      req = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch { throw new UploadError("Invalid upload descriptor"); }
  } else {
    if (!cfg.disableSign) throw new UploadError("Missing upload descriptor", 403);
    req = {
      path: url.searchParams.get("path"),
      file_name: url.searchParams.get("file_name"),
      file_size: Number(url.searchParams.get("file_size") ?? request.headers.get("Content-Length") ?? -1),
      overwrite: url.searchParams.get("overwrite") !== "false",
      format: url.searchParams.get("format") || "raw",
      response: url.searchParams.get("response") || "json",
      storage_id: 0,
      storage_time: 0,
    };
  }
  if (!req || !Number.isSafeInteger(req.file_size) || req.file_size < 0) throw new UploadError("Invalid file size");
  req.method = request.method;
  req.worker_address = cfg.worker;
  req.sign = url.searchParams.get("sign") || "";
  delete req.hash;
  const contentType = request.headers.get("Content-Type") || "application/octet-stream";
  req.format = contentType.split(";", 1)[0].trim().toLowerCase() === "multipart/form-data" ? "form" : "raw";
  if (req.format === "raw") {
    req.content_type = contentType;
    const length = request.headers.get("Content-Length");
    if (length !== null && Number(length) !== req.file_size) throw new UploadError("Content-Length mismatch");
  } else {
    req.content_type = "application/octet-stream";
  }
  return req;
}

async function control(fetcher, cfg, operation, body) {
  const headers = { "Content-Type": "application/json" };
  if (!cfg.disableSign) headers.Authorization = cfg.token;
  const response = await fetcher(`${cfg.address}/api/upload_proxy/${operation}`, {
    method: "POST", headers, redirect: "manual",
    body: JSON.stringify({ ...body, disable_sign: cfg.disableSign }),
  });
  const data = await readLimited(response.body, 128 * 1024);
  let result;
  try { result = JSON.parse(new TextDecoder().decode(data)); }
  catch { throw new UploadError("Invalid OpenList response", 502); }
  if (!response.ok || result.code !== 200) {
    // Provider credentials can occur in upstream diagnostics. Keep them server-side.
    throw new UploadError(`OpenList ${operation} rejected the request (code ${result.code || response.status})`, 403);
  }
  return result.data;
}

async function fileSource(request, req, rules) {
  const limit = Math.min(rules.buffer_max, HARD_BUFFER_LIMIT);
  if (req.format === "form") {
    if (req.file_size > limit) throw new UploadError("Form upload exceeds buffer limit", 413);
    const wire = await readLimited(request.body, Math.min(limit + 64 * 1024, HARD_BUFFER_LIMIT + 64 * 1024));
    const form = await new Response(wire, { headers: { "Content-Type": request.headers.get("Content-Type") || "" } }).formData();
    const entries = [...form.entries()];
    const file = form.get("file");
    if (entries.length !== 1 || !(file instanceof Blob) || file.name !== req.file_name || file.size !== req.file_size) {
      throw new UploadError("Form requires exactly one matching file field");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (rules.hash) req.hash = createHash(rules.hash).update(bytes).digest("hex");
    return { bytes, body: null };
  }
  if (rules.hash) {
    if (!["md5", "sha256"].includes(rules.hash) || req.file_size > limit) throw new UploadError("Hash upload exceeds buffer limit", 413);
    const bytes = await readLimited(request.body, limit, req.file_size);
    req.hash = createHash(rules.hash).update(bytes).digest("hex");
    return { bytes, body: null };
  }
  return { bytes: null, body: request.body };
}

function providerBody(source, req, plan) {
  const encoder = new TextEncoder();
  let prefix = new Uint8Array(), suffix = new Uint8Array();
  const headers = new Headers(plan.headers || {});
  if (plan.encoding === "multipart") {
    const boundary = `openlist-${crypto.randomUUID()}`;
    const quote = text => String(text).replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
    let text = "";
    for (const [name, value] of Object.entries(plan.fields || {})) {
      text += `--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n${value}\r\n`;
    }
    text += `--${boundary}\r\nContent-Disposition: form-data; name="${quote(plan.file_field)}"; filename="${quote(req.file_name)}"\r\nContent-Type: ${req.content_type}\r\n\r\n`;
    prefix = encoder.encode(text);
    suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
    headers.set("Content-Type", `multipart/form-data; boundary=${boundary}`);
  } else if (plan.encoding && plan.encoding !== "raw") {
    throw new UploadError("Unsupported provider encoding", 502);
  }
  if (!headers.has("Content-Type")) headers.set("Content-Type", req.content_type);
  const fileStream = source.bytes ? new Blob([source.bytes]).stream() : source.body;
  const reader = fileStream?.getReader();
  const md5 = createHash("md5");
  const sha256 = req.content_sha256 ? createHash("sha256") : null;
  let etag = "";
  let bytes = 0, stage = 0, ended = false;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        if (stage === 0) { stage = 1; if (prefix.length) { controller.enqueue(prefix); return; } }
        if (stage === 1) {
          const next = reader ? await reader.read() : { done: true };
          if (!next.done) {
            bytes += next.value.byteLength;
            if (bytes > req.file_size) throw new UploadError("Upload exceeds authorized size", 413);
            md5.update(next.value);
            sha256?.update(next.value);
            controller.enqueue(next.value);
            return;
          }
          if (bytes !== req.file_size) throw new UploadError("Upload size mismatch");
          const digest = md5.digest();
          etag = `"${digest.toString("hex")}"`;
          if (req.content_md5 && digest.toString("base64") !== req.content_md5) throw new UploadError("Content-MD5 mismatch");
          if (sha256 && sha256.digest("hex") !== req.content_sha256) throw new UploadError("SHA-256 mismatch");
          stage = 2;
          if (suffix.length) { controller.enqueue(suffix); return; }
        }
        ended = true;
        controller.close();
      } catch (err) { await reader?.cancel(err); controller.error(err); }
    },
    async cancel(reason) { await reader?.cancel(reason); },
  });
  const length = req.file_size + prefix.length + suffix.length;
  // Cloudflare derives Content-Length from FixedLengthStream. Node uses the header in tests.
  if (typeof FixedLengthStream !== "undefined") {
    const fixed = new FixedLengthStream(length);
    const transferAbort = new AbortController();
    const done = stream.pipeTo(fixed.writable, { signal: transferAbort.signal });
    done.catch(() => {});
    return {
      body: fixed.readable, headers,
      complete: async () => { await done; return { bytes, etag }; },
      cancel: async reason => { transferAbort.abort(reason); await done.catch(() => {}); },
    };
  }
  headers.set("Content-Length", String(length));
  return { body: stream, headers, complete: async () => { if (!ended) throw new UploadError("Provider did not consume upload", 502); return { bytes, etag }; }, cancel: async reason => { await reader?.cancel(reason); if (!stream.locked) await stream.cancel(reason); } };
}

export function createHandler(fetcher = fetch) {
  return {
    async fetch(request, env) {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
      let cfg, req, uploadID;
      try {
        cfg = config(env);
        const url = new URL(request.url);
        const uploadPath = new URL(`${cfg.worker}/upload`).pathname;
        if (url.pathname !== uploadPath) return jsonResponse(request, 404, "Not found");
        if (request.method !== "PUT") return jsonResponse(request, 405, "Method not allowed");
        req = descriptor(request, cfg);
        const rules = await control(fetcher, cfg, "verify", req);
        const source = await fileSource(request, req, rules);
        const prepared = await control(fetcher, cfg, "prepare", req);
        uploadID = prepared.upload_id;
        const plan = prepared.plan;
        let result = { success: true, status: 200, body: "", bytes: req.file_size, etag: "" };
        if (plan.instant) {
          const incoming = providerBody(source, req, {});
          await incoming.body.pipeTo(new WritableStream());
          result.etag = (await incoming.complete()).etag;
        } else {
          const target = new URL(plan.url);
          if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new UploadError("Invalid provider URL", 502);
          const outgoing = providerBody(source, req, plan);
          try {
            const response = await fetcher(target.href, {
              method: plan.method, headers: outgoing.headers, body: outgoing.body,
              redirect: "manual", duplex: "half", signal: request.signal,
            });
            if (!response.ok) {
              await outgoing.cancel(new UploadError("Provider upload failed", 502));
              throw new UploadError("Provider upload failed", 502);
            }
            const transfer = await outgoing.complete();
            const body = await readLimited(response.body, RESPONSE_LIMIT);
            result = { success: response.ok, status: response.status, body: new TextDecoder().decode(body), bytes: transfer.bytes, etag: transfer.etag };
          } catch (err) { await outgoing.cancel(err).catch(() => {}); throw err; }
        }
        await control(fetcher, cfg, "complete", { upload_id: uploadID, result });
        uploadID = null;
        if (!result.success) throw new UploadError("Provider upload failed", 502);
        const headers = { ...cors(request) };
        if (result.etag) headers.ETag = result.etag;
        if (req.response === "s3" || req.response === "webdav") {
          return new Response(null, { status: req.response === "webdav" ? 201 : 200, headers });
        }
        return jsonResponse(request, 200, "success");
      } catch (err) {
        if (uploadID) {
          await control(fetcher, cfg, "complete", { upload_id: uploadID, result: { success: false, status: 0, bytes: 0, body: "", etag: "" } }).catch(() => {});
        }
        const message = err instanceof UploadError ? err.message : "Upload failed";
        return jsonResponse(request, err instanceof UploadError ? err.status : 502, message);
      }
    },
  };
}

export default createHandler();
