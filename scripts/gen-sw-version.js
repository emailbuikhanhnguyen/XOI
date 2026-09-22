#!/usr/bin/env node
// ============================================================
// Tự động sinh version cache cho sw.js dựa trên HASH nội dung thật của các
// file trong "app shell" (chứ không phải tự tay gõ số như trước — dễ quên,
// quên là người dùng bị kẹt ở bản cũ). Mỗi khi nội dung đổi, hash đổi theo,
// CACHE_NAME trong sw.js tự đổi, trình duyệt tự biết có bản mới cần tải lại
// và xoá cache cũ. Nội dung không đổi → hash không đổi → không sửa gì cả
// (không tạo diff thừa).
//
// Chạy tự động mỗi lần `git commit` (xem .husky/pre-commit). Cũng có thể
// chạy tay: `npm run build:sw-version`.
// ============================================================

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SW_PATH = join(ROOT, "sw.js");
const CACHE_NAME_RE = /const CACHE_NAME = "[^"]*";/;

// Các file mà khi đổi nội dung thì người dùng đang mở app PHẢI được tải bản
// mới — danh sách nên khớp với APP_SHELL khai báo trong sw.js (không tính
// chính sw.js, xử lý riêng bên dưới để tránh vòng lặp tự tham chiếu phiên
// bản cũ của chính nó vào hash mới).
const WATCHED_FILES = [
  "index.html",
  "styles.css",
  "app.js",
  "src/calc.js",
  "src/constants.js",
  "src/firebase-init.js",
  "src/state.js",
  "src/ui.js",
  "src/network.js",
  "src/data.js",
  "src/auth.js",
  "src/router.js",
  "src/screens/trang-chu.js",
  "src/screens/cham-cong.js",
  "src/screens/kho.js",
  "src/screens/thu-chi.js",
  "src/screens/bao-cao.js",
  "src/screens/quan-ly.js",
  "firebase-config.js",
  "manifest.webmanifest",
];

function main() {
  const swSource = readFileSync(SW_PATH, "utf8");
  if (!CACHE_NAME_RE.test(swSource)) {
    console.error('gen-sw-version: không tìm thấy dòng `const CACHE_NAME = "...";` trong sw.js.');
    process.exit(1);
  }

  // Thay dòng CACHE_NAME bằng 1 placeholder cố định trước khi hash sw.js:
  // nếu hash cả version cũ vào, mỗi lần chạy sẽ ra 1 hash mới dù nội dung
  // thật không đổi gì (vì hash(x) phụ thuộc ngược vào chính giá trị nó sắp
  // ghi ra) — placeholder cố định tránh vòng lặp đó.
  const normalizedSw = swSource.replace(CACHE_NAME_RE, 'const CACHE_NAME = "__PLACEHOLDER__";');

  const hash = createHash("sha256");
  hash.update(normalizedSw);
  for (const rel of WATCHED_FILES) {
    hash.update(rel); // tên file cũng vào hash, để đổi tên file cũng bust cache
    hash.update(readFileSync(join(ROOT, rel)));
  }

  const shortHash = hash.digest("hex").slice(0, 10);
  const newCacheName = `so-xoi-${shortHash}`;
  const newSw = swSource.replace(CACHE_NAME_RE, `const CACHE_NAME = "${newCacheName}";`);

  if (newSw === swSource) {
    console.log(`gen-sw-version: CACHE_NAME đã đúng (${newCacheName}), không cần sửa.`);
    return;
  }

  writeFileSync(SW_PATH, newSw);
  console.log(`gen-sw-version: đã cập nhật sw.js → CACHE_NAME = "${newCacheName}"`);
}

main();
