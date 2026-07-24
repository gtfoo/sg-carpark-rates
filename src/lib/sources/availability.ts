const AVAILABILITY = "https://api.data.gov.sg/v1/transport/carpark-availability";

interface RawAvailability {
  items: {
    timestamp: string;
    carpark_data: {
      carpark_number: string;
      update_datetime: string;
      carpark_info: {
        lot_type: string;
        lots_available: string;
        total_lots: string;
      }[];
    }[];
  }[];
}

export interface Availability {
  carparkNo: string;
  lotsAvailable: number;
  totalLots: number;
  occupancy: number;
  updatedAt: string;
}

/**
 * Live availability, or a historical snapshot when `at` is supplied.
 *
 * The historical capability is the reason the "how likely am I to get a lot"
 * feature is viable at all — verified working back to at least mid-2024, so
 * two years of history can be backfilled without having collected it yourself.
 */
export async function fetchAvailability(
  at?: Date,
): Promise<Map<string, Availability>> {
  const url = at
    ? `${AVAILABILITY}?date_time=${encodeURIComponent(toSgtParam(at))}`
    : AVAILABILITY;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`availability failed: HTTP ${res.status}`);

  const body = (await res.json()) as RawAvailability;
  const items = body.items?.[0]?.carpark_data ?? [];
  const map = new Map<string, Availability>();

  for (const entry of items) {
    // lot_type C = car. c.f. Y (motorcycle), H (heavy vehicle).
    const car = entry.carpark_info.find((i) => i.lot_type === "C");
    if (!car) continue;

    const lotsAvailable = Number(car.lots_available);
    const totalLots = Number(car.total_lots);
    if (!Number.isFinite(lotsAvailable) || totalLots <= 0) continue;

    map.set(entry.carpark_number, {
      carparkNo: entry.carpark_number,
      lotsAvailable,
      totalLots,
      occupancy: 1 - lotsAvailable / totalLots,
      updatedAt: entry.update_datetime,
    });
  }

  return map;
}

/** The API expects local SGT without a timezone suffix. */
function toSgtParam(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "");
}
