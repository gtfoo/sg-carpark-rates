import { fetchAllRecords } from "./datagov";
import { svy21ToLatLng, type LatLng } from "../geo";

const HDB_CARPARK_INFO = "d_23f946fa557947f93a8043bbef41dd09";

interface RawHdbCarpark {
  car_park_no: string;
  address: string;
  x_coord: string;
  y_coord: string;
  car_park_type: string;
  type_of_parking_system: string;
  short_term_parking: string;
  free_parking: string;
  night_parking: string;
  car_park_decks: string;
  gantry_height: string;
  car_park_basement: string;
}

export type Shelter = "sheltered" | "open-air" | "partial" | "unknown";

export interface HdbCarpark {
  carparkNo: string;
  address: string;
  location: LatLng;
  /** Raw HDB classification, e.g. "MULTI-STOREY CAR PARK". */
  carparkType: string;
  isBasement: boolean;
  /** INFERRED from carparkType — HDB publishes no shelter field. */
  shelter: Shelter;
  /** Coupon carparks require the parking.sg app; electronic ones use a gantry. */
  needsParkingApp: boolean;
  parkingSystem: string;
  shortTermParking: string;
  freeParking: string;
  nightParking: boolean;
  decks: number;
  gantryHeightM: number;
}

/**
 * HDB has no "sheltered" attribute, so this is an inference from structure
 * type. Surface carparks are open-air; anything with decks or a basement is
 * covered. Surface/multi-storey hybrids are genuinely mixed — we say so
 * rather than pick a side, and the UI should label these as approximate.
 */
function inferShelter(carparkType: string): Shelter {
  const t = carparkType.toUpperCase();
  if (t.includes("SURFACE") && t.includes("MULTI-STOREY")) return "partial";
  if (t.includes("BASEMENT") || t.includes("MULTI-STOREY")) return "sheltered";
  if (t.includes("SURFACE")) return "open-air";
  return "unknown";
}

export async function fetchHdbCarparks(): Promise<HdbCarpark[]> {
  const raw = await fetchAllRecords<RawHdbCarpark>(HDB_CARPARK_INFO);

  return raw.map((r) => ({
    carparkNo: r.car_park_no,
    address: r.address,
    location: svy21ToLatLng(Number(r.x_coord), Number(r.y_coord)),
    carparkType: r.car_park_type,
    isBasement: r.car_park_basement === "Y",
    shelter: inferShelter(r.car_park_type),
    needsParkingApp: r.type_of_parking_system
      .toUpperCase()
      .includes("COUPON"),
    parkingSystem: r.type_of_parking_system,
    shortTermParking: r.short_term_parking,
    freeParking: r.free_parking,
    nightParking: r.night_parking?.toUpperCase() === "YES",
    decks: Number(r.car_park_decks) || 0,
    gantryHeightM: Number(r.gantry_height) || 0,
  }));
}
