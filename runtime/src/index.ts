import "dotenv/config";
import { loadConfig } from "./config.js";
import { RuntimeWsServer } from "./server/wsServer.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = new RuntimeWsServer(config);
  server.start();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}, shutting down runtime`);
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void main();
