import { afterEach, describe, expect, it, vi } from "vitest";

import { searchPubMed } from "./pubmed.js";
import esearchFixture from "./__fixtures__/pubmed-esearch.json" with { type: "json" };
import esummaryFixture from "./__fixtures__/pubmed-esummary.json" with { type: "json" };

function makeResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.PUBMED_API_KEY;
});

describe("searchPubMed", () => {
  it("issues esearch then esummary and maps results into Citation[]", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse(esearchFixture))
      .mockResolvedValueOnce(makeResponse(esummaryFixture));

    const citations = await searchPubMed("osimertinib AND EGFR", 3);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const esearchUrl = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(esearchUrl.pathname).toContain("esearch.fcgi");
    expect(esearchUrl.searchParams.get("db")).toBe("pubmed");
    expect(esearchUrl.searchParams.get("term")).toBe("osimertinib AND EGFR");
    expect(esearchUrl.searchParams.get("retmax")).toBe("3");
    expect(esearchUrl.searchParams.get("retmode")).toBe("json");

    const esummaryUrl = new URL(fetchSpy.mock.calls[1]![0] as string);
    expect(esummaryUrl.pathname).toContain("esummary.fcgi");
    expect(esummaryUrl.searchParams.get("id")).toBe("39603809,39463445,39298753");

    expect(citations).toHaveLength(3);
    const first = citations[0]!;
    expect(first.pmid).toBe("39603809");
    expect(first.title).toContain("Osimertinib");
    expect(first.year).toBe(2024);
    expect(first.url).toBe("https://pubmed.ncbi.nlm.nih.gov/39603809/");
  });

  it("returns [] when esearch returns no PMIDs (skips esummary)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeResponse({
        header: { type: "esearch", version: "0.3" },
        esearchresult: { count: "0", retmax: "0", retstart: "0", idlist: [] },
      }),
    );
    const out = await searchPubMed("very rare query", 10);
    expect(out).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves PMID order in the output (the esearch ranking)", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse(esearchFixture))
      .mockResolvedValueOnce(makeResponse(esummaryFixture));
    const out = await searchPubMed("x", 3);
    expect(out.map((c) => c.pmid)).toEqual(["39603809", "39463445", "39298753"]);
  });

  it("leaves year undefined when pubdate is unparseable", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse(esearchFixture))
      .mockResolvedValueOnce(makeResponse(esummaryFixture));
    const out = await searchPubMed("x", 3);
    const third = out.find((c) => c.pmid === "39298753")!;
    expect(third.year).toBeUndefined();
  });

  it("appends api_key when PUBMED_API_KEY is set", async () => {
    process.env.PUBMED_API_KEY = "test-key";
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse(esearchFixture))
      .mockResolvedValueOnce(makeResponse(esummaryFixture));
    await searchPubMed("x", 3);
    const esearchUrl = new URL(fetchSpy.mock.calls[0]![0] as string);
    const esummaryUrl = new URL(fetchSpy.mock.calls[1]![0] as string);
    expect(esearchUrl.searchParams.get("api_key")).toBe("test-key");
    expect(esummaryUrl.searchParams.get("api_key")).toBe("test-key");
  });

  it("retries on 429 with backoff (mirrors clinicaltrials)", async () => {
    vi.useFakeTimers();
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse({}, { status: 429 }))
      .mockResolvedValueOnce(makeResponse(esearchFixture))
      .mockResolvedValueOnce(makeResponse(esummaryFixture));
    const promise = searchPubMed("x", 3);
    await vi.advanceTimersByTimeAsync(1100);
    const out = await promise;
    expect(out).toHaveLength(3);
  });

  it("throws after exhausting retries on persistent 503", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(makeResponse({}, { status: 503 }));
    // Attach the rejection assertion BEFORE advancing timers, so the
    // .rejects handler is in place when the promise actually rejects
    // (during advanceTimersByTimeAsync). Otherwise Node briefly sees an
    // unhandled rejection and vitest fails the run despite the assertion
    // matching. The async helper used here (esearch) adds a microtask
    // that the symmetric clinicaltrials test doesn't have.
    const assertion = expect(searchPubMed("x", 3)).rejects.toThrow(
      /PubMed.*503/,
    );
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
