import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  appendReferenceImages,
  loadReferenceImage,
  parseDataUrl,
  validateReferenceImageSource,
} from "./reference-images.ts";

test("Data URL 会被解码为图片字节并生成稳定文件名", () => {
  const source = "data:image/jpeg;base64," + Buffer.from("jpeg-bytes").toString("base64");
  assert.equal(validateReferenceImageSource(source), "data_url");
  assert.deepEqual([...parseDataUrl(source).bytes], [...Buffer.from("jpeg-bytes")]);
});

test("HTTP(S) 参考图会下载并作为 image[] 文件追加", async (t: TestContext) => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response("remote-image", {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const form = new FormData();
  await appendReferenceImages(form, ["https://cdn.example.test/source.png?token=test"]);
  const file = form.get("image[]") as File;
  assert.equal(requests[0], "https://cdn.example.test/source.png?token=test");
  assert.equal(file.name, "source.png");
  assert.equal(file.type, "image/png");
  assert.equal(await file.text(), "remote-image");
});

test("Data URL 和无扩展名远程 URL 都能统一为图片字节", async (t: TestContext) => {
  const source = "data:image/png;base64," + Buffer.from("data-image").toString("base64");
  const dataImage = await loadReferenceImage(source, 2);
  assert.equal(dataImage.filename, "reference-2.png");
  assert.equal(new TextDecoder().decode(dataImage.bytes), "data-image");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Uint8Array.from([1, 2, 3]), {
    status: 200,
    headers: { "Content-Type": "image/webp" },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const remoteImage = await loadReferenceImage("https://cdn.example.test/no-extension", 3);
  assert.equal(remoteImage.filename, "reference-3.webp");
  assert.deepEqual([...remoteImage.bytes], [1, 2, 3]);
});
