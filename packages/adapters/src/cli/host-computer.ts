import { hostname } from "node:os";
import { startHostComputerServer } from "../host-computer-server.js";

/**
 * Runs this machine as a host computer that dials a Rakazo server. No port is opened, so it works
 * on a machine the server cannot reach. The desktop app starts the same server itself.
 *
 *   node host-computer.js --server https://app.example.com --token <token> --root /var/lib/rakazo
 */
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (name?.startsWith("--") && value) args.set(name.slice(2), value);
}

const serverUrl = args.get("server");
const token = args.get("token");
const root = args.get("root");
if (!serverUrl || !token || !root) {
  process.stderr.write("Usage: host-computer --server <https-url> --token <token> --root <dir>\n");
  process.exit(1);
}

const host = startHostComputerServer({
  mode: "connect",
  serverUrl,
  token,
  root,
  authorize: async () => true,
  onRevoked: () => {
    process.stderr.write(`${hostname()} was disconnected from the server.\n`);
    process.exit(1);
  },
});

const stop = () => {
  host.close();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
