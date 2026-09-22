// Khởi tạo Firebase (app, auth, db) — dùng chung cho toàn bộ app. Các module
// khác import { app, auth, db } từ đây thay vì tự initializeApp() lại.
import { firebaseConfig } from "../firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Bật lưu offline: chấm công / nhập kho / chuyển hàng vẫn lưu được khi mất
// mạng (ghi vào IndexedDB của trình duyệt), tự đồng bộ lên Firestore ngay
// khi có mạng lại — không cần chờ mạng mới thao tác được ở quầy.
export let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
} catch (err) {
  // Trình duyệt/chế độ không hỗ trợ persistence (vd. một số trình duyệt ẩn
  // danh) → rơi về Firestore bình thường (chỉ hoạt động khi có mạng).
  console.error("Không bật được lưu offline, dùng chế độ online-only:", err);
  db = getFirestore(app);
}
