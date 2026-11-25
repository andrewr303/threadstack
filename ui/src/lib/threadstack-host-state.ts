// This state is set by the origin-checked host handshake, never by a parent message alone.
let verified = false;
const observers = new Set<() => void>();
export const isVerifiedThreadStackHost = () => verified;
export function setVerifiedThreadStackHost(value: boolean): void {
  if (verified === value) return;
  verified = value;
  for (const observer of observers) observer();
}
export function subscribeVerifiedThreadStackHost(observer: () => void): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}
