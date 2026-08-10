import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateHdbFee, isProbablyCentral, HDB_RATES } from "../src/lib/fees";
import { fromSgt } from "../src/lib/time";

/**
 * The HDB fee engine, and the central-area guess that doubles every price when
 * it gets a car park wrong. Blk 47/49 Tanglin Halt Road was billed $6.54 for
 * two hours against parking.sg's $2.40 — a too-wide boundary plus a GST line
 * that shouldn't have been there. Both are pinned below.
 */

const NO_HOLIDAYS = new Set<string>();

/** A coupon car park open all day, with no free-parking window. */
function coupon(start: Date, minutes: number, isCentral: boolean) {
  return calculateHdbFee({
    start,
    minutes,
    isCentral,
    perMinuteBilling: false,
    freeParking: "NO",
    shortTermParking: "WHOLE DAY",
    nightParking: true,
    holidays: NO_HOLIDAYS,
  });
}

// Fri 7 Aug 2026, 2pm Singapore — a plain weekday inside the day window.
const WEEKDAY_2PM = fromSgt(2026, 8, 7, 14);

test("a stay past closing time accounts for every minute", () => {
  // Blk 271 Punggol Walk sells short-term parking 7am-10.30pm only. A two-hour
  // stay from 9.35pm showed "Charged 55 min" against "120 min" above it, with
  // the other 65 minutes silently dropped — the total looked arbitrary.
  const at2135 = fromSgt(2026, 8, 9, 21, 35);
  const shortHours = calculateHdbFee({
    start: at2135,
    minutes: 120,
    isCentral: false,
    perMinuteBilling: true,
    freeParking: "NO",
    shortTermParking: "7AM-10.30PM",
    nightParking: false,
    holidays: NO_HOLIDAYS,
  });
  assert.equal(shortHours.chargedMinutes, 55);
  assert.equal(shortHours.outsideMinutes, 65);
  assert.equal(shortHours.freeMinutes, 0);
  assert.equal(shortHours.chargedMinutes + shortHours.outsideMinutes + shortHours.freeMinutes, 120);
  assert.equal(shortHours.total, 1.1);
  assert.match(shortHours.notes.join(" "), /7am-10\.30pm/i);

  // The same stay where the car park sells all day: nothing falls outside.
  const allDay = calculateHdbFee({
    start: at2135,
    minutes: 120,
    isCentral: false,
    perMinuteBilling: true,
    freeParking: "NO",
    shortTermParking: "WHOLE DAY",
    nightParking: true,
    holidays: NO_HOLIDAYS,
  });
  assert.equal(allDay.outsideMinutes, 0);
  assert.equal(allDay.chargedMinutes, 120);
  assert.equal(allDay.total, 2.4);

  // And where Sunday free parking runs to 10.30pm, the first 55 min are free
  // rather than unsold — a different reason for a different number.
  const sunday = fromSgt(2026, 8, 9, 21, 35); // 9 Aug 2026 is a Sunday
  const freeThenPaid = calculateHdbFee({
    start: sunday,
    minutes: 120,
    isCentral: false,
    perMinuteBilling: true,
    freeParking: "SUN & PH FR 7AM-10.30PM",
    shortTermParking: "WHOLE DAY",
    nightParking: true,
    holidays: NO_HOLIDAYS,
  });
  assert.equal(freeThenPaid.freeMinutes, 55);
  assert.equal(freeThenPaid.chargedMinutes, 65);
  assert.equal(freeThenPaid.outsideMinutes, 0);
  assert.equal(freeThenPaid.total, 1.3);
});

test("central-area boundary: estates that were being overcharged", () => {
  // Every one of these was billed the central rate — double — by the bounding
  // box this replaced. Each sits in the Central REGION but outside the Central
  // AREA, which is the distinction that matters.
  //
  // Blk 77/72/71/58 Seng Poh Road is the anchor: parking.sg charges $2.40 for
  // two hours there, i.e. non-central. It is BUKIT MERAH.
  assert.equal(isProbablyCentral(1.2837, 103.8316), false, "Seng Poh Road");
  assert.equal(isProbablyCentral(1.2839, 103.833), false, "Seng Poh Lane");
  assert.equal(isProbablyCentral(1.2832, 103.8306), false, "Moh Guan Terrace");
  assert.equal(isProbablyCentral(1.2853, 103.8199), false, "Jalan Bukit Merah");
  assert.equal(isProbablyCentral(1.3, 103.7973), false, "Tanglin Halt");
  assert.equal(isProbablyCentral(1.3005, 103.8004), false, "Commonwealth");
  assert.equal(isProbablyCentral(1.3339, 103.8489), false, "Toa Payoh");

  // Genuinely central, and must stay that way.
  assert.equal(isProbablyCentral(1.3032, 103.8367), true, "Orchard");
  assert.equal(isProbablyCentral(1.2821, 103.8516), true, "Raffles Place");
  assert.equal(isProbablyCentral(1.2823, 103.8432), true, "Chinatown (Outram)");
  assert.equal(isProbablyCentral(1.2996, 103.8542), true, "Bugis (Rochor)");
});

test("Seng Poh Road bills $2.40 for two hours, as parking.sg does", () => {
  const f = coupon(WEEKDAY_2PM, 120, isProbablyCentral(1.2837, 103.8316));
  assert.equal(f.total, 2.4);
});

test("somewhere far from the Central Area is never central", () => {
  for (const [name, lat, lng] of [
    ["Jurong East", 1.3329, 103.7436],
    ["Tampines", 1.3496, 103.9568],
    ["Woodlands", 1.4382, 103.789],
    ["Changi Airport", 1.3644, 103.9915],
  ] as const) {
    assert.equal(isProbablyCentral(lat, lng), false, name);
  }
});

test("two hours at a non-central coupon car park is $2.40", () => {
  // The exact figure parking.sg shows for Blk 47/49 Tanglin Halt Road.
  const f = coupon(WEEKDAY_2PM, 120, false);
  assert.equal(f.total, 2.4);
});

test("central costs exactly double", () => {
  assert.equal(coupon(WEEKDAY_2PM, 120, true).total, 4.8);
  assert.equal(HDB_RATES.central.perHalfHour, HDB_RATES.nonCentral.perHalfHour * 2);
});

test("no GST is added — published rates are what parking.sg bills", () => {
  const f = coupon(WEEKDAY_2PM, 120, false);
  assert.equal(f.gst, 0);
  assert.equal(f.total, f.dollarsBeforeGst);
});

test("coupon rounds up to whole half-hours, EPS bills per minute", () => {
  const perMinute = calculateHdbFee({
    start: WEEKDAY_2PM,
    minutes: 100,
    isCentral: false,
    perMinuteBilling: true,
    freeParking: "NO",
    shortTermParking: "WHOLE DAY",
    nightParking: true,
    holidays: NO_HOLIDAYS,
  });
  // 100 min x $0.02 = $2.00, versus 4 whole blocks x $0.60 = $2.40.
  assert.equal(perMinute.total, 2);
  assert.equal(coupon(WEEKDAY_2PM, 100, false).total, 2.4);
});

test("a car park with no short-term parking is free, not chargeable", () => {
  const f = calculateHdbFee({
    start: WEEKDAY_2PM,
    minutes: 120,
    isCentral: false,
    perMinuteBilling: true,
    freeParking: "NO",
    shortTermParking: "NO",
    nightParking: true,
    holidays: NO_HOLIDAYS,
  });
  assert.equal(f.total, 0);
  assert.equal(f.chargedMinutes, 0);
});

test("Sunday free-parking window is honoured", () => {
  // Sun 9 Aug 2026, 2pm — inside "SUN & PH FR 7AM-10.30PM".
  const f = calculateHdbFee({
    start: fromSgt(2026, 8, 9, 14),
    minutes: 120,
    isCentral: false,
    perMinuteBilling: true,
    freeParking: "SUN & PH FR 7AM-10.30PM",
    shortTermParking: "WHOLE DAY",
    nightParking: true,
    holidays: NO_HOLIDAYS,
  });
  assert.equal(f.total, 0);
  assert.equal(f.freeMinutes, 120);
});

test("the daily cap stops a long stay running away", () => {
  // 07:00 to 22:30 is the whole day window: 930 min x $0.02 = $18.60 uncapped.
  const f = calculateHdbFee({
    start: fromSgt(2026, 8, 7, 7),
    minutes: 930,
    isCentral: false,
    perMinuteBilling: true,
    freeParking: "NO",
    shortTermParking: "WHOLE DAY",
    nightParking: true,
    holidays: NO_HOLIDAYS,
  });
  assert.equal(f.total, HDB_RATES.nonCentral.dayCap);
  assert.equal(f.capApplied, true);
});
