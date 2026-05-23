import { describe, expect, it } from "vitest";

import {
  ENROLLING_STATUSES,
  isEnrollingStatus,
  parseAgeYears,
} from "./ctgov.js";

describe("parseAgeYears", () => {
  it("parses N Years", () => {
    expect(parseAgeYears("18 Years")).toBe(18);
    expect(parseAgeYears("75 Years")).toBe(75);
  });

  it("parses N Months as a fractional year", () => {
    expect(parseAgeYears("6 Months")).toBeCloseTo(0.5, 5);
    expect(parseAgeYears("24 Months")).toBeCloseTo(2, 5);
    expect(parseAgeYears("1 Month")).toBeCloseTo(1 / 12, 5);
  });

  it("parses N Weeks as a fractional year", () => {
    expect(parseAgeYears("2 Weeks")).toBeCloseTo(2 / 52.1775, 5);
    expect(parseAgeYears("1 Week")).toBeCloseTo(1 / 52.1775, 5);
  });

  it("parses N Days as a fractional year", () => {
    expect(parseAgeYears("28 Days")).toBeCloseTo(28 / 365.25, 5);
    expect(parseAgeYears("1 Day")).toBeCloseTo(1 / 365.25, 5);
  });

  it("parses N Hours as a fractional year (newborn-only trials)", () => {
    expect(parseAgeYears("48 Hours")).toBeCloseTo(48 / (365.25 * 24), 5);
    expect(parseAgeYears("1 Hour")).toBeCloseTo(1 / (365.25 * 24), 5);
  });

  it("parses N Minutes as a fractional year (moment-of-birth trials)", () => {
    expect(parseAgeYears("1 Minute")).toBeCloseTo(1 / (365.25 * 24 * 60), 5);
  });

  it("returns undefined for N/A", () => {
    expect(parseAgeYears("N/A")).toBeUndefined();
  });

  it("returns undefined for missing or unparseable strings", () => {
    expect(parseAgeYears(undefined)).toBeUndefined();
    expect(parseAgeYears("")).toBeUndefined();
    expect(parseAgeYears("18")).toBeUndefined();
    expect(parseAgeYears("eighteen years")).toBeUndefined();
  });
});

describe("isEnrollingStatus", () => {
  it("returns true for enrolling-ish statuses", () => {
    for (const s of ENROLLING_STATUSES) {
      expect(isEnrollingStatus(s)).toBe(true);
    }
  });

  it("returns false for non-enrolling statuses", () => {
    expect(isEnrollingStatus("COMPLETED")).toBe(false);
    expect(isEnrollingStatus("WITHDRAWN")).toBe(false);
    expect(isEnrollingStatus("TERMINATED")).toBe(false);
    expect(isEnrollingStatus("SUSPENDED")).toBe(false);
  });

  it("returns false for empty / unknown strings", () => {
    expect(isEnrollingStatus("")).toBe(false);
    expect(isEnrollingStatus("not a real status")).toBe(false);
  });
});
