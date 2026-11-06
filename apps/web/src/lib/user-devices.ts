import { t } from "@lingui/core/macro";
import type { UserDevicePairResponse, UserDeviceSummary } from "@rakazo/contracts";
import { USER_DEVICE_PAIR_PATH, USER_DEVICE_PATH, userDeviceListSchema } from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";

export async function listUserDevices(): Promise<UserDeviceSummary[]> {
  const response = await fetch(USER_DEVICE_PATH, { signal: AbortSignal.timeout(8_000) });
  // Servers without user devices have no such route.
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(t`Could not load`);
  try {
    return userDeviceListSchema.parse(await readBoundedJsonResponse<unknown>(response, 64 * 1024))
      .devices;
  } catch {
    throw new Error(t`Could not load`);
  }
}

/** Pairs a machine by name. The token is returned once and is not stored here. */
export async function pairUserDevice(name: string): Promise<UserDevicePairResponse> {
  const platform = navigator.platform.toLowerCase().includes("win")
    ? "win32"
    : navigator.platform.toLowerCase().includes("linux")
      ? "linux"
      : "darwin";
  const response = await fetch(USER_DEVICE_PAIR_PATH, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, platform }),
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 409) throw new Error(t`Remove a computer before adding another`);
  if (!response.ok) throw new Error(t`Could not add`);
  try {
    return (await readBoundedJsonResponse<unknown>(response, 8 * 1024)) as UserDevicePairResponse;
  } catch {
    throw new Error(t`Could not add`);
  }
}

export async function removeUserDevice(deviceId: string): Promise<void> {
  const response = await fetch(`${USER_DEVICE_PATH}/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(8_000),
  });
  await response.body?.cancel();
  if (!response.ok && response.status !== 404) throw new Error(t`Could not remove`);
}
