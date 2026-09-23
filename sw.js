// CACHE_NAME giờ được TỰ ĐỘNG sinh ra từ hash nội dung các file trong
// APP_SHELL (xem scripts/gen-sw-version.js) mỗi khi bạn `git commit` —
// không cần tự tay đổi số nữa. Đừng sửa tay dòng dưới đây; nếu commit mà
// không thấy dòng này tự đổi dù có sửa code, chạy tay:
// `npm run build:sw-version` rồi commit lại. Trước đây quên đổi số bản
// (v2, v3...) là nguyên nhân người dùng bị "kẹt" ở bản HTML/JS cũ (vd. màn
// đăng nhập không tự ẩn sau khi đăng nhập thành công) dù code nguồn đã sửa
// xong — cơ chế tự động này giải quyết đúng vấn đề đó.
const CACHE_NAME = "so-xoi-02fb4c0637";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./src/calc.js",
  "./src/constants.js",
  "./src/firebase-init.js",
  "./src/state.js",
  "./src/ui.js",
  "./src/network.js",
  "./src/data.js",
  "./src/auth.js",
  "./src/router.js",
  "./src/screens/trang-chu.js",
  "./src/screens/cham-cong.js",
  "./src/screens/kho.js",
  "./src/screens/thu-chi.js",
  "./src/screens/bao-cao.js",
  "./src/screens/quan-ly.js",
  "./src/screens/huong-dan.js",
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
