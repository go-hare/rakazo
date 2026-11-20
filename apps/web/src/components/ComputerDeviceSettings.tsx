import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useCallback, useEffect, useId, useState } from "react";
import type { DaemonMachine, DaemonPin } from "../lib/daemon-machines";
import { listDaemonMachines, pinDaemonMachine } from "../lib/daemon-machines";
import { rpc } from "../lib/rpc";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

export function ComputerDeviceSettings() {
  const { t } = useLingui();
  const [machines, setMachines] = useState<DaemonMachine[]>([]);
  const [pins, setPins] = useState<Record<string, DaemonPin>>({});
  const [bots, setBots] = useState<Bot[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cwdId = useId();

  const load = useCallback(async () => {
    const [listed, listedBots] = await Promise.all([
      listDaemonMachines().catch(() => null),
      rpc.bots.list().catch(() => null),
    ]);
    if (listed) {
      setMachines(listed.machines);
      setPins(listed.pins);
    }
    if (listedBots) setBots(listedBots);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(botId: string, machineId: string, cwd: string, agent: string) {
    const directory = cwd.trim();
    if (machineId && !directory) return;
    setPending(true);
    setError(null);
    try {
      await pinDaemonMachine(botId, machineId, directory, agent);
    } catch {
      setError(t`Could not change`);
    } finally {
      await load();
      setPending(false);
    }
  }

  return (
    <SettingsGroup title={<Trans>Computers</Trans>} data-testid="computer-devices">
      <p className="px-4 pt-3 text-body-sm text-muted-foreground">
        <Trans>On that computer, run</Trans> <code>rakazo-daemon login {location.origin}</code>
      </p>
      {machines.map((machine) => (
        <SettingsRow
          key={machine.id}
          label={
            <p className="flex min-w-0 items-baseline gap-2">
              <span className="truncate">{machine.name}</span>
              <span className="shrink-0 text-body-sm text-muted-foreground">
                {machine.online ? <Trans>Connected</Trans> : <Trans>Offline</Trans>}
              </span>
            </p>
          }
        />
      ))}
      {machines.length > 0
        ? bots.map((bot) => {
            const pin = pins[bot.id];
            return (
              <SettingsRow
                key={bot.id}
                label={<span className="truncate">{bot.name}</span>}
                control={
                  <form
                    className="flex min-w-0 flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const data = new FormData(event.currentTarget);
                      void save(
                        bot.id,
                        String(data.get("machine") ?? ""),
                        String(data.get("cwd") ?? ""),
                        String(data.get("agent") ?? "claude"),
                      );
                    }}
                  >
                    <NativeSelect
                      className="max-w-full min-w-28 shrink-0"
                      name="machine"
                      aria-label={t`${bot.name} runs on`}
                      defaultValue={pin?.machineId ?? ""}
                      disabled={pending}
                    >
                      <NativeSelectOption value="">{t`Server`}</NativeSelectOption>
                      {machines.map((machine) => (
                        <NativeSelectOption key={machine.id} value={machine.id}>
                          {machine.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <NativeSelect
                      className="max-w-full min-w-24 shrink-0"
                      name="agent"
                      aria-label={t`${bot.name} agent`}
                      defaultValue={pin?.agent ?? "claude"}
                      disabled={pending}
                    >
                      <NativeSelectOption value="claude">claude</NativeSelectOption>
                      <NativeSelectOption value="codex">codex</NativeSelectOption>
                      <NativeSelectOption value="grok">grok</NativeSelectOption>
                    </NativeSelect>
                    <Field className="min-w-0 flex-1 basis-40">
                      <FieldLabel htmlFor={`${cwdId}-${bot.id}`} className="sr-only">
                        <Trans>Directory</Trans>
                      </FieldLabel>
                      <Input
                        id={`${cwdId}-${bot.id}`}
                        name="cwd"
                        defaultValue={pin?.cwd ?? ""}
                        placeholder={t`Directory`}
                        disabled={pending}
                      />
                    </Field>
                    <Button type="submit" size="sm" className="shrink-0" disabled={pending}>
                      <Trans>Save</Trans>
                    </Button>
                  </form>
                }
              />
            );
          })
        : null}
      {error ? (
        <p role="alert" className="px-4 py-3 text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
