import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../openlist-upload-worker.js";

const env = { ADDRESS: "https://openlist.test", TOKEN: "private-token", WORKER_ADDRESS: "https://worker.test", DISABLE_SIGN: "false" };
const desc = { path: "/cloud", file_name: "file.txt", file_size: 3, method: "PUT", format: "raw", content_type: "text/plain", overwrite: true, response: "json", worker_address: env.WORKER_ADDRESS, storage_id: 1, storage_time: 123 };
function request(data = desc, body = "abc", headers = { "Content-Type": "text/plain" }) {
  return new Request(`https://worker.test/upload?payload=${Buffer.from(JSON.stringify(data)).toString("base64url")}&sign=opaque-sign`, { method: "PUT", body, headers, duplex: "half" });
}
function ok(data) { return Response.json({ code: 200, message: "success", data }); }

test("stream to provider, keep Token private, and notify before reporting success", async () => {
  const calls = [];
  const worker = createHandler(async (url, options) => {
    calls.push(url);
    if (url.startsWith(env.ADDRESS)) {
      assert.equal(options.headers.Authorization, env.TOKEN);
      const body = JSON.parse(options.body);
      if (url.endsWith("/verify")) { assert.equal(body.sign, "opaque-sign"); return ok({ hash: "", buffer_max: 1024 }); }
      if (url.endsWith("/prepare")) return ok({ upload_id: "id", plan: { url: "https://provider.test/upload", method: "PUT", headers: { Cookie: "provider-session" } } });
      assert.equal(body.result.bytes, 3);
      assert.equal(body.result.etag, '"900150983cd24fb0d6963f7d28e17f72"');
      return ok(null);
    }
    assert.equal(options.headers.get("Authorization"), null);
    assert.equal(options.headers.get("Cookie"), "provider-session");
    assert.equal(await new Response(options.body).text(), "abc");
    return new Response("done");
  });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).code, 200);
  assert.deepEqual(calls.map(u => u.split("/").at(-1)), ["verify", "prepare", "upload", "complete"]);
});

test("OpenList rejection never reads file content or contacts provider", async () => {
  let reads = 0, calls = 0;
  const body = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array([1])); } }, { highWaterMark: 0 });
  const worker = createHandler(async () => { calls++; return Response.json({ code: 403, message: "secret upstream detail" }); });
  const response = await worker.fetch(request(desc, body), env);
  assert.equal(response.status, 403);
  assert.equal(reads, 0);
  assert.equal(calls, 1);
  assert.doesNotMatch(await response.text(), /secret upstream detail/);
});

test("anonymous upload needs no Token and submits rules to OpenList", async () => {
  const worker = createHandler(async (url, options) => {
    if (!url.startsWith(env.ADDRESS)) { await new Response(options.body).arrayBuffer(); return new Response(); }
    const body = JSON.parse(options.body);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(body.disable_sign, true);
    if (url.endsWith("verify")) { assert.equal(body.path, "/cloud"); return ok({ hash: "", buffer_max: 1024 }); }
    if (url.endsWith("prepare")) return ok({ upload_id: "id", plan: { url: "https://provider.test/upload", method: "PUT" } });
    return ok(null);
  });
  const response = await worker.fetch(new Request("https://worker.test/upload?path=/cloud&file_name=file.txt&file_size=3", { method: "PUT", body: "abc" }), { ...env, TOKEN: "", DISABLE_SIGN: "true" });
  assert.equal(response.status, 200);
});

test("MD5 is calculated in Worker and provider receives streaming multipart", async () => {
  const worker = createHandler(async (url, options) => {
    if (url.endsWith("verify")) return ok({ hash: "md5", buffer_max: 1024 });
    if (url.endsWith("prepare")) {
      assert.equal(JSON.parse(options.body).hash, "900150983cd24fb0d6963f7d28e17f72");
      return ok({ upload_id: "id", plan: { url: "https://provider.test/upload", method: "POST", encoding: "multipart", file_field: "upload_file", fields: { token: "provider-token" } } });
    }
    if (url.endsWith("complete")) return ok(null);
    const form = await new Response(options.body, { headers: options.headers }).formData();
    assert.equal(form.get("token"), "provider-token");
    assert.equal(await form.get("upload_file").text(), "abc");
    assert.equal(form.get("upload_file").name, "file.txt");
    return new Response("result");
  });
  assert.equal((await worker.fetch(request(), env)).status, 200);
});

test("short body never reports success and sends failure notification", async () => {
  let failed = false;
  const worker = createHandler(async (url, options) => {
    if (url.endsWith("verify")) return ok({ hash: "", buffer_max: 1024 });
    if (url.endsWith("prepare")) return ok({ upload_id: "id", plan: { url: "https://provider.test/upload", method: "PUT" } });
    if (url.endsWith("complete")) { failed = !JSON.parse(options.body).result.success; return ok(null); }
    await new Response(options.body).arrayBuffer();
    return new Response();
  });
  const response = await worker.fetch(request(desc, "ab"), env);
  assert.notEqual(response.status, 200);
  assert.equal(failed, true);
});

test("S3 gets empty success response and content ETag", async () => {
  const worker = createHandler(async (url, options) => {
    if (url.endsWith("verify")) return ok({ hash: "", buffer_max: 1024 });
    if (url.endsWith("prepare")) return ok({ upload_id: "id", plan: { url: "https://provider.test/upload", method: "PUT" } });
    if (url.endsWith("complete")) return ok(null);
    await new Response(options.body).arrayBuffer(); return new Response();
  });
  const response = await worker.fetch(request({ ...desc, response: "s3" }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("ETag"), '"900150983cd24fb0d6963f7d28e17f72"');
  assert.equal(await response.text(), "");
});

test("checksum mismatch aborts upload", async () => {
  const worker = createHandler(async (url, options) => {
    if (url.endsWith("verify")) return ok({ hash: "", buffer_max: 1024 });
    if (url.endsWith("prepare")) return ok({ upload_id: "id", plan: { url: "https://provider.test/upload", method: "PUT" } });
    if (url.endsWith("complete")) return ok(null);
    await new Response(options.body).arrayBuffer(); return new Response();
  });
  assert.notEqual((await worker.fetch(request({ ...desc, content_md5: "invalid" }), env)).status, 200);
});

test("OpenList verifies the actual incoming format", async () => {
  let calls = 0;
  const worker = createHandler(async (url, options) => {
    calls++;
    assert.equal(url, `${env.ADDRESS}/api/upload_proxy/verify`);
    assert.equal(JSON.parse(options.body).format, "form");
    return Response.json({ code: 403 });
  });
  const body = new FormData();
  body.set("file", new Blob(["abc"]), "file.txt");
  assert.equal((await worker.fetch(request(desc, body, {}), env)).status, 403);
  assert.equal(calls, 1);
});

test("instant upload consumes and checks the file without provider transfer", async () => {
  const worker = createHandler(async (url, options) => {
    if (url.endsWith("verify")) return ok({ hash: "", buffer_max: 1 });
    if (url.endsWith("prepare")) return ok({ upload_id: "id", plan: { instant: true } });
    assert.equal(url, `${env.ADDRESS}/api/upload_proxy/complete`);
    const result = JSON.parse(options.body).result;
    assert.equal(result.bytes, 3);
    assert.equal(result.etag, '"900150983cd24fb0d6963f7d28e17f72"');
    return ok(null);
  });
  assert.equal((await worker.fetch(request(), env)).status, 200);
});

test("provider rejection cancels the incoming stream and notifies failure", async () => {
  let canceled = false, failed = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array([1])); },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 });
  const worker = createHandler(async (url, options) => {
    if (url.endsWith("verify")) return ok({ hash: "", buffer_max: 1024 });
    if (url.endsWith("prepare")) return ok({ upload_id: "id", plan: { url: "https://provider.test/upload", method: "PUT" } });
    if (url.endsWith("complete")) { failed = !JSON.parse(options.body).result.success; return ok(null); }
    return new Response("rejected", { status: 403 });
  });
  assert.equal((await worker.fetch(request(desc, body), env)).status, 502);
  assert.equal(canceled, true);
  assert.equal(failed, true);
});
