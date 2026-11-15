// This state is set by the origin-checked host handshake, never by a parent message alone.
let verified = false;
const observers = new Set<() => void>();
export const isVerifiedThreadkeeperHost = () => verified;
export function setVerifiedThreadkeeperHost(value: boolean): void {
  if (verified === value) return;
  verified = value;
  for (const observer of observers) observer();
}
export function subscribeVerifiedThreadkeeperHost(observer: () => void): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}
