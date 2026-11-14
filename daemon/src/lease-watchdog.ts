export function leaseWatchdog(timeoutMs: number, expire: () => void) {
  let deadline = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let confirmed = false;
  let expired = false;
  const stop = () => {
    if (expired) return;
    expired = true;
    clearTimeout(timer);
    expire();
  };
  const renew = () => {
    deadline = performance.now() + timeoutMs;
    clearTimeout(timer);
    timer = setTimeout(stop, timeoutMs);
  };
  renew();
  return {
    receiveHeartbeat() {
      if (expired || performance.now() >= deadline) {
        stop();
        return;
      }
      confirmed = true;
      renew();
    },
    canReceive() {
      if (!expired && performance.now() >= deadline) stop();
      return confirmed && !expired;
    },
    close() {
      expired = true;
      clearTimeout(timer);
    },
  };
}
