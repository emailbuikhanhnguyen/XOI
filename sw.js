// Đổi số bản (v2, v3, ...) mỗi khi bạn deploy code mới, để buộc mọi
// điện thoại xoá cache cũ và tải bản mới nhất — nếu quên đổi số này,
// người dùng có thể bị "kẹt" ở bản HTML/JS cũ (ví dụ: màn đăng nhập
// không tự ẩn sau khi đăng nhập thành công) dù code nguồn đã sửa xong.
const CACHE_NAME = "so-xoi-v6";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Network-first cho mọi thứ (trừ Firebase): luôn thử tải bản mới nhất
// từ mạng trước, chỉ rơi về cache khi mất mạng. Nhờ vậy khi bạn deploy
// bản cập nhật, người dùng luôn thấy bản mới ngay khi có mạng, mà vẫn
// dùng được app lúc mất mạng (offline) nhờ bản cache gần nhất.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = event.request.url;
  const isFirebase = url.includes("googleapis.com") || url.includes("firebaseio.com") || url.includes("gstatic.com/firebasejs");
  if (isFirebase) return; // để trình duyệt xử lý trực tiếp, không cache

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => cached || caches.match("./index.html"))
      )
  );
});
