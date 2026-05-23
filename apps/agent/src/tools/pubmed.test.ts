import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAbstracts, searchPubMed } from "./pubmed.js";
import esearchFixture from "./__fixtures__/pubmed-esearch.json" with { type: "json" };
import esummaryFixture from "./__fixtures__/pubmed-esummary.json" with { type: "json" };

const efetchFixture = readFileSync(
  fileURLToPath(new URL("./__fixtures__/pubmed-efetch.txt", import.meta.url)),
  "utf8",
);

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

describe("searchPubMed (pubtype populated)", () => {
  it("populates pubtype from esummary response", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse(esearchFixture))
      .mockResolvedValueOnce(makeResponse(esummaryFixture));
    const cits = await searchPubMed("x", 3);
    expect(cits[0]!.pubtype).toEqual(
      expect.arrayContaining(["Journal Article", "Randomized Controlled Trial"]),
    );
    expect(cits[2]!.pubtype).toEqual(["Review"]); // matches fixture entry #3
  });

  it("defaults pubtype to [] when esummary has none", async () => {
    // Add a fourth fixture entry with no pubtype to the in-test esummary mock.
    const minimalEsummary = JSON.parse(JSON.stringify(esummaryFixture));
    minimalEsummary.result.uids.push("00000001");
    minimalEsummary.result["00000001"] = {
      uid: "00000001",
      pubdate: "2024",
      title: "t",
      articleids: [{ idtype: "pubmed", value: "00000001" }],
    };
    const esearchWithFour = JSON.parse(JSON.stringify(esearchFixture));
    esearchWithFour.esearchresult.idlist.push("00000001");

    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(makeResponse(esearchWithFour))
      .mockResolvedValueOnce(makeResponse(minimalEsummary));
    const cits = await searchPubMed("x", 4);
    const minimal = cits.find((c) => c.pmid === "00000001")!;
    expect(minimal.pubtype).toEqual([]);
  });
});

describe("fetchAbstracts", () => {
  it("parses EFetch text response into a Map keyed by PMID", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(efetchFixture, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const map = await fetchAbstracts(["39603809", "39463445"]);
    expect(map.get("39603809")).toContain(
      "Osimertinib is a third-generation EGFR-TKI",
    );
    expect(map.get("39463445")).toContain("EGFR T790M mutation");
  });

  it("truncates each abstract to 500 chars", async () => {
    const longText = `1. N Engl J Med. 2024.

Long.

Author information:
(1)x

${"x".repeat(2000)}

PMID: 12345678
`;
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(longText, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const map = await fetchAbstracts(["12345678"]);
    expect(map.get("12345678")!.length).toBeLessThanOrEqual(500);
  });

  it("skips records without an abstract (e.g. editorials)", async () => {
    const noAbs = `1. JAMA. 2024.

Editorial title.

PMID: 87654321
`;
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(noAbs, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const map = await fetchAbstracts(["87654321"]);
    expect(map.has("87654321")).toBe(false);
  });

  it("returns an empty map for empty pmids input (no network call)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const map = await fetchAbstracts([]);
    expect(map.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retries on 503 with backoff (mirrors searchPubMed pattern)", async () => {
    vi.useFakeTimers();
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(efetchFixture, {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );
    const promise = fetchAbstracts(["39603809"]);
    await vi.advanceTimersByTimeAsync(1100);
    const map = await promise;
    expect(map.has("39603809")).toBe(true);
  });

  it("appends api_key when PUBMED_API_KEY is set", async () => {
    process.env.PUBMED_API_KEY = "test-key";
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(efetchFixture, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    await fetchAbstracts(["39603809"]);
    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    expect(url.searchParams.get("api_key")).toBe("test-key");
  });
});
