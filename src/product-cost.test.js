import { describe, it, expect } from "vitest";
import { manualProductCost } from "./calc.js";

describe("Giá vốn nhập tay", () => {
  it("nhận mức giá hợp lệ và giá 0", () => {
    expect(manualProductCost({ giaVonMoiVien: 4000 })).toBe(4000);
    expect(manualProductCost({ giaVonMoiVien: 0 })).toBe(0);
  });
  it("để trống, thiếu hoặc sai kiểu dùng định mức cũ", () => {
    for (const value of [null, undefined, "", "4000", -1, NaN, Infinity]) {
      expect(manualProductCost({ giaVonMoiVien: value })).toBeNull();
    }
  });
});
