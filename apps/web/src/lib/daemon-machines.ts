import { t } from "@lingui/core/macro";
import { readBoundedJsonResponse } from "@rakazo/core";

export interface DaemonMachine {
  id: string;
  name: string;
  online: boolean;
  cwd: string;
}

export interface DaemonPin {
  machineId: string;
  cwd: string;
  agent?: string;
}

export async function listDaemonMachines(): Promise<{
  machines: DaemonMachine[];
  pins: Record<string, DaemonPin>;
}> {
  const response = await fetch("/api/machines", {
    credentials: "include",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(t`Could not load`);
  const body = await readBoundedJsonResponse<{ machines?: DaemonMachine[]; pins?: Record<string, DaemonPin> }>(
    response,
    64 * 1024,
  );
  return { machines: body.machines ?? [], pins: body.pins ?? {} };
}

export async function pinDaemonMachine(
  botId: string,
  machineId: string,
  cwd: string,
  agent: string,
): Promise<void> {
  const response = await fetch(`/api/bots/${botId}/machine`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machineId, cwd, agent }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(t`Could not change`);
}
