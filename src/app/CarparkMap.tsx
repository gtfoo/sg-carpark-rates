"use client";

import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { SearchResponse, CarparkResult } from "@/lib/search";
import { formatFee } from "@/lib/format";

/**
 * OneMap raster tiles — free, no API key, and the authoritative Singapore
 * basemap. Using these instead of Google Maps keeps the app at $0: Google
 * retired its universal monthly credit in Mar 2025 and now bills roughly
 * $7 per 1,000 map loads beyond a small free tier.
 */
const TILES = {
  light: "https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png",
  dark: "https://www.onemap.gov.sg/maps/tiles/Night/{z}/{x}/{y}.png",
};

/** OneMap only covers Singapore; clamp so users cannot pan into blank space. */
const SG_BOUNDS = L.latLngBounds([1.144, 103.535], [1.494, 104.502]);

const ATTRIBUTION =
  '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" ' +
  'style="height:16px;vertical-align:middle" alt="OneMap"/> ' +
  '<a href="https://www.onemap.gov.sg/" target="_blank" rel="noreferrer">OneMap</a> ' +
  '&copy; contributors | <a href="https://www.sla.gov.sg/" target="_blank" ' +
  'rel="noreferrer">Singapore Land Authority</a>';

function useIsDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}

/**
 * Leaflet's default marker images break under bundlers because they are
 * resolved by relative URL. divIcon sidesteps that entirely and lets us colour
 * pins by availability without shipping any image assets.
 */
function pin(colour: string, label: string, big = false): L.DivIcon {
  const size = big ? 30 : 24;
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${colour};border:2px solid rgba(255,255,255,.9);
      box-shadow:0 1px 4px rgba(0,0,0,.5);
      display:flex;align-items:center;justify-content:center;
      color:#fff;font:600 ${big ? 13 : 10}px/1 ui-sans-serif,system-ui;
    ">${label}</div>`,
  });
}

function availabilityColour(r: CarparkResult): string {
  if (r.lotsAvailable === null || !r.totalLots) return "#6b7280"; // no feed
  const free = r.lotsAvailable / r.totalLots;
  if (free < 0.05) return "#ef4444";
  if (free < 0.2) return "#f59e0b";
  return "#22c55e";
}

/** Refits the viewport whenever a new search comes in. */
function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 17 });
  }, [map, points]);
  return null;
}

export default function CarparkMap({ data }: { data: SearchResponse }) {
  const dark = useIsDark();

  // Commercial carparks have no coordinates in the LTA dataset, so they can
  // only appear in the list, never on the map.
  const mappable = useMemo(
    () => data.results.filter((r) => r.location !== null),
    [data.results],
  );

  const points = useMemo<[number, number][]>(
    () => [
      [data.destination.location.lat, data.destination.location.lng],
      ...mappable.map((r) => [r.location!.lat, r.location!.lng] as [number, number]),
    ],
    [data.destination, mappable],
  );

  return (
    <div
      className="mb-4 overflow-hidden rounded-xl border"
      style={{ borderColor: "var(--border)" }}
    >
      <MapContainer
        center={[data.destination.location.lat, data.destination.location.lng]}
        zoom={16}
        style={{ height: 280, width: "100%", background: "var(--surface)" }}
        maxBounds={SG_BOUNDS}
        minZoom={11}
        scrollWheelZoom={false}
      >
        <TileLayer
          url={dark ? TILES.dark : TILES.light}
          attribution={ATTRIBUTION}
          maxZoom={19}
        />

        <Marker
          position={[data.destination.location.lat, data.destination.location.lng]}
          icon={pin("#5b8cff", "★", true)}
          zIndexOffset={1000}
        >
          <Popup>
            <strong>{data.destination.name}</strong>
            <br />
            {data.destination.address}
          </Popup>
        </Marker>

        {mappable.map((r, i) => (
          <Marker
            key={r.id}
            position={[r.location!.lat, r.location!.lng]}
            icon={pin(availabilityColour(r), String(i + 1))}
          >
            <Popup>
              <strong>{r.name}</strong>
              <br />
              {r.distanceIsWalking ? "walk" : "approx"} {r.distanceM} m
              {" · "}
              {r.shelter}
              <br />
              {r.fee !== null && (
                <>{r.fee <= 0 ? "Free" : `Fee: ${formatFee(r.fee)}`}</>
              )}
              {r.lotsAvailable !== null && (
                <>
                  <br />
                  {r.lotsAvailable === 0
                    ? `Full (0 of ${r.totalLots} free)`
                    : `${r.lotsAvailable} of ${r.totalLots} lots free`}
                </>
              )}
            </Popup>
          </Marker>
        ))}

        <FitBounds points={points} />
      </MapContainer>
    </div>
  );
}
