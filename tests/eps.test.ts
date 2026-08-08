import { test } from "node:test";
import assert from "node:assert/strict";
import { displayName } from "../src/lib/sources/eps";

test("a URA internal code is replaced by the car park's address", () => {
  // Reached the card as "Ura_p0075", which tells a driver nothing.
  assert.equal(
    displayName("URA_P0075", "51, LAVENDER STREET, P0075"),
    "51 LAVENDER STREET",
  );
  assert.equal(
    displayName("URA_W0029", "1, WEST COAST PARK, W0029"),
    "1 WEST COAST PARK",
  );
  // A house number of 0 is a placeholder, not an address.
  assert.equal(
    displayName("URA_T0017", "0, TIONG BAHRU ROAD, T0017"),
    "TIONG BAHRU ROAD",
  );
  // Nothing usable in the address — better the code than an empty card.
  assert.equal(displayName("URA_X0001", "X0001"), "URA_X0001");
});

test("ordinary EPS names are left alone", () => {
  assert.equal(displayName("CT HUB 2", "114, LAVENDER STREET, CT HUB 2"), "CT HUB 2");
  // HDB codes stay as they are — they're excluded from search entirely, and
  // the HDB dataset owns those car parks under a readable name.
  assert.equal(displayName("HDB_J4_J5", "BLK 201, JURONG EAST ST 21"), "HDB_J4_J5");
  // The CapitaLand " - C" tier suffix is still trimmed.
  assert.equal(displayName("Plaza Singapura - C", "68, ORCHARD ROAD"), "Plaza Singapura");
});
