/** Formats a computed parking fee: "Free" for $0, a dash when unknown, else "$4.80". */
export function formatFee(fee: number | null): string {
  if (fee === null) return "—";
  if (fee <= 0) return "Free";
  return `$${fee.toFixed(2)}`;
}
