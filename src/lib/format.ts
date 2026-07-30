/** Formats a computed parking fee: "Free" for $0, a dash when unknown, else "$4.80". */
export function formatFee(fee: number | null): string {
  if (fee === null) return "—";
  if (fee <= 0) return "Free";
  return `$${fee.toFixed(2)}`;
}

/** Rough walking time from a distance in metres, at ~80 m/min (~4.8 km/h). */
export function walkMinutes(metres: number): number {
  return Math.max(1, Math.round(metres / 80));
}
