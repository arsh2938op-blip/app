import { MockRobot } from "./mockRobot.js";

const port = Number(process.env.MOCK_PORT ?? 8080);
const robot = new MockRobot({
  port,
  host: process.env.MOCK_HOST ?? "0.0.0.0",
  cliff: process.env.MOCK_CLIFF ? Number(process.env.MOCK_CLIFF) : undefined,
});
const actual = await robot.start();

console.log(`WALL-E mock robot listening on TCP ${actual}`);
console.log("  Set MOCK_CLIFF=2|3|4 to rehearse a cliff refusal.");

const shutdown = async () => {
  await robot.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
