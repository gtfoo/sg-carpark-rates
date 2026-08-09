/** Shared client for data.gov.sg. No API key needed for these endpoints. */

const DATASTORE = "https://data.gov.sg/api/action/datastore_search";

interface DatastoreResponse<T> {
  result: {
    total: number;
    records: T[];
    fields: { id: string; type: string }[];
  };
}

/**
 * Fetch with retry+backoff. data.gov.sg rate-limits at ~60 req/min and 429s in
 * bursts; a transient 429/5xx shouldn't fail the caller on the first try.
 */
async function fetchWithRetry(url: string, attempts = 4): Promise<Response> {
  let lastStatus = 0;
  for (let i = 0; i < attempts; i++) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      // Network blip — back off and retry.
      await sleep(backoffMs(i));
      continue;
    }
    if (res.ok) return res;
    lastStatus = res.status;
    // Only retry transient failures; a 400/404 won't fix itself.
    if (res.status !== 429 && res.status < 500) return res;
    if (i < attempts - 1) await sleep(backoffMs(i));
  }
  throw new Error(`request failed after ${attempts} attempts: HTTP ${lastStatus}`);
}

function backoffMs(attempt: number): number {
  // 0.5s, 1s, 2s, … plus jitter.
  return 500 * 2 ** attempt + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * When the dataset itself was last republished, as YYYY-MM-DD.
 *
 * This is the date a rate taken from it was last true, which is NOT the date we
 * imported it. Recording the import date instead made 346 stored rates claim
 * they had been verified a fortnight ago when the source behind them had not
 * moved since June 2024, and the age shown on the card — one of the few signals
 * telling a driver how much to trust the number — said the opposite of the
 * truth. Returns null if the metadata can't be read; callers should then record
 * no date rather than invent today's.
 */
export async function fetchDatasetLastUpdated(
  datasetId: string,
): Promise<string | null> {
  try {
    const res = await fetchWithRetry(
      `https://api-production.data.gov.sg/v2/public/api/datasets/${datasetId}/metadata`,
    );
    const body = (await res.json()) as {
      data?: {
        lastUpdatedAt?: string;
        datasetMetadata?: { lastUpdatedAt?: string };
      };
    };
    // The field sits directly on `data`. It was read one level too deep at
    // first, which returned undefined every time — worth accepting both shapes
    // rather than depending on an undocumented response layout.
    const at = body.data?.lastUpdatedAt ?? body.data?.datasetMetadata?.lastUpdatedAt;
    return at ? at.slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Pages through a datastore resource until every record is retrieved. */
export async function fetchAllRecords<T>(
  resourceId: string,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const url = `${DATASTORE}?resource_id=${resourceId}&limit=${pageSize}&offset=${offset}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) {
      throw new Error(`datastore ${resourceId} failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as DatastoreResponse<T>;
    total = body.result.total;
    out.push(...body.result.records);
    if (body.result.records.length === 0) break;
    offset += pageSize;
  }

  return out;
}
