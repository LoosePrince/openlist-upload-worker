import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("Cloudflare workerd runtime streams using FixedLengthStream and node crypto", async () => {
  let providerBytes = 0, completed = false, failed = false;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/provider-rejected") {
      res.statusCode = 403;
      res.end("rejected");
      req.resume();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const wire = Buffer.concat(chunks);
    if (req.url === "/provider") {
      providerBytes = wire.length;
      assert.equal(req.headers["content-length"], "3");
      assert.equal(wire.toString(), "abc");
      assert.equal(req.headers.authorization, undefined);
      res.end("done");
      return;
    }
    assert.equal(req.headers.authorization, "runtime-token");
    const data = JSON.parse(wire);
    let result;
    if (req.url.endsWith("verify")) result = { hash: "", buffer_max: 1024 };
    else if (req.url.endsWith("prepare")) result = { upload_id: "runtime", plan: { url: `${origin}/${data.file_name === "reject.txt" ? "provider-rejected" : "provider"}`, method: "PUT" } };
    else {
      if (data.result.success) {
        assert.equal(data.result.bytes, 3);
        assert.equal(data.result.etag, '"900150983cd24fb0d6963f7d28e17f72"');
        completed = true;
      } else {
        failed = true;
      }
      result = null;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ code: 200, data: result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  let mf;
  try {
    mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
      name: "upload-test",
      modules: true,
      scriptPath: new URL("../openlist-upload-worker.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      compatibilityDate: "2026-10-09",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { ADDRESS: origin, TOKEN: "runtime-token", WORKER_ADDRESS: "https://worker.test", DISABLE_SIGN: "false" },
    }] }));
    const payload = Buffer.from(JSON.stringify({ path: "/cloud", file_name: "file.txt", file_size: 3, format: "raw", response: "s3" })).toString("base64url");
    const response = await mf.dispatchFetch(`https://worker.test/upload?payload=${payload}&sign=opaque`, { method: "PUT", body: "abc", headers: { "Content-Type": "text/plain" } });
    assert.equal(response.status, 200, await response.text());
    assert.equal(providerBytes, 3);
    assert.equal(completed, true);
    assert.equal(response.headers.get("ETag"), '"900150983cd24fb0d6963f7d28e17f72"');
    const rejectedPayload = Buffer.from(JSON.stringify({ path: "/cloud", file_name: "reject.txt", file_size: 1024 * 1024, format: "raw", response: "s3" })).toString("base64url");
    const rejected = await mf.dispatchFetch(`https://worker.test/upload?payload=${rejectedPayload}&sign=opaque`, { method: "PUT", body: new Uint8Array(1024 * 1024) });
    assert.equal(rejected.status, 502, await rejected.text());
    assert.equal(failed, true);
  } finally {
    await mf?.dispose();
    await new Promise(resolve => server.close(resolve));
  }
});
