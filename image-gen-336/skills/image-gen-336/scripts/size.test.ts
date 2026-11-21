import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAspectRatio,
  parsePixelSize,
  parseResolution,
  resolveImageSize,
  sizeForAspectRatio,
  validatePixelSize,
  validateResolution,
} from "./size.ts";

test("尺寸工具解析并校验正数像素尺寸", () => {
  assert.deepEqual(parsePixelSize(" 1024 x 768 "), { width: 1024, height: 768 });
  assert.equal(parsePixelSize("0x768"), null);
  assert.equal(parsePixelSize("bad"), null);
  assert.equal(validatePixelSize("1024x1024"), "1024x1024");
  assert.throws(() => validatePixelSize("1024x0"), /positive/);
  assert.equal(parseResolution("4k"), "4k");
  assert.equal(validateResolution("1K"), "1k");
  assert.equal(parseResolution("512"), null);
  assert.equal(parseResolution("0.5K"), null);
  assert.throws(() => validateResolution("512"), /Expected 1K, 2K, or 4K/);
  assert.throws(() => validateResolution("8K"), /Expected 1K, 2K, or 4K/);
});

test("宽高比换算为官方 API 可用的像素 size", () => {
  assert.deepEqual(parseAspectRatio("16:9"), { width: 16, height: 9 });
  assert.equal(parseAspectRatio("0:1"), null);
  assert.equal(sizeForAspectRatio("1:1", "normal"), "1024x1024");
  assert.equal(sizeForAspectRatio("16:9", "2k"), "2048x1152");
  assert.equal(sizeForAspectRatio("9:16", "normal"), "608x1088");
  assert.equal(sizeForAspectRatio("16:9", "2k", "1k"), "1536x864");
  assert.equal(sizeForAspectRatio("1:1", "2k", "4k"), "2880x2880");
  assert.throws(() => sizeForAspectRatio("4:1", "2k"), /must not exceed 3:1/);
});

test("显式 size 优先于 ar，未指定时按 quality 使用正方形默认值", () => {
  assert.equal(resolveImageSize("800x600", "16:9", "2k"), "800x600");
  assert.equal(resolveImageSize(null, "4:3", "normal"), "1024x768");
  assert.equal(resolveImageSize(null, null, "2k"), "2048x2048");
  assert.equal(resolveImageSize(null, null, "normal", "1k"), "1024x1024");
});
