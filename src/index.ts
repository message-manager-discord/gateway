// Runs gateway cache library - and adds metrics
import * as Sentry from "@sentry/node";
import fastify from "fastify";
import promClient from "prom-client";
import { GatewayClient } from "redis-discord-cache";
import winston from "winston";

/* -------------------------
   Environment
-------------------------- */

const HOST = process.env.REDIS_HOST;
const PORT_STRING = process.env.REDIS_PORT;
const TOKEN = process.env.DISCORD_TOKEN;

const METRICS_PORT_STRING = process.env.METRICS_PORT;
const METRICS_HOST = process.env.METRICS_HOST;
const METRICS_AUTH = process.env.METRICS_AUTH;

if (!PORT_STRING || !TOKEN) {
  throw new Error("Missing environment variables");
}

const PORT = Number(PORT_STRING);
if (Number.isNaN(PORT)) {
  throw new Error("REDIS_PORT must be a valid number");
}

const METRICS_PORT = METRICS_PORT_STRING
  ? Number(METRICS_PORT_STRING)
  : undefined;

if (METRICS_PORT_STRING && Number.isNaN(METRICS_PORT)) {
  throw new Error("METRICS_PORT must be a valid number");
}

/* -------------------------
   Sentry + Logger
-------------------------- */

Sentry.init({ dsn: process.env.SENTRY_DSN });

const logger = winston.createLogger({
  level: process.env.LOGGING_LEVEL ?? "info",
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
      handleExceptions: true,
    }),
  ],
  exitOnError: false,
});

/* -------------------------
   Metrics
-------------------------- */

const metricsPrefix = "discord_gateway_";

const guildsGauge = new promClient.Gauge({
  name: `${metricsPrefix}guild_count`,
  help: "Number of guilds",
});

const eventsCounter = new promClient.Counter({
  name: `${metricsPrefix}gateway_events_count`,
  help: "Number of gateway events",
  labelNames: ["name"],
});

const redisCommandsCounter = new promClient.Counter({
  name: `${metricsPrefix}redis_commands_count`,
  help: "Number of redis commands",
  labelNames: ["name"],
});

/* -------------------------
   Handlers
-------------------------- */

const handlePacketError = (error: unknown) => {
  Sentry.captureException(error);
};

const handleGatewayEvent = ({ name }: { name: string }) => {
  eventsCounter.inc({ name });
};

const handleRedisCommand = ({ name }: { name: string }) => {
  redisCommandsCounter.inc({ name });
};

/* -------------------------
   Shards
-------------------------- */

const shardCount = 2;

async function startShards(token: string) {
  const shards: GatewayClient[] = [];

  for (let shardId = 0; shardId < shardCount; shardId++) {
    const shard = new GatewayClient({
      redis: { host: HOST, port: PORT },
      discord: {
        token,
        presence: { status: "online" },
        shardCount,
        shardId,
      },
      logger,
      metrics: {
        onGatewayEvent: handleGatewayEvent,
        onRedisCommand: handleRedisCommand,
      },
      onErrorInPacketHandler: handlePacketError,
    });

    await shard.connect();
    shards.push(shard);
  }

  return shards;
}

/* -------------------------
   Metrics loop
-------------------------- */

function startMetricsLoop(shards: GatewayClient[]) {
  const update = async () => {
    const counts = await Promise.all(shards.map((s) => s.getGuildCount()));

    const total = counts.reduce((a, b) => a + b, 0);
    guildsGauge.set(total);
  };

  void update();

  const interval = setInterval(() => {
    void update();
  }, 15_000);

  return () => clearInterval(interval);
}

/* -------------------------
   Metrics server
-------------------------- */

async function startMetricsServer() {
  if (!METRICS_PORT || !METRICS_HOST) return;

  const app = fastify();

  app.get(
    "/metrics",
    {
      preHandler: async (req, reply) => {
        const auth = req.headers.authorization?.replace(/BEARER\s*/i, "");

        if (auth !== METRICS_AUTH) {
          return reply.code(401).send("Unauthorized");
        }
      },
    },
    async (_req, reply) => {
      return reply.type("text/plain").send(await promClient.register.metrics());
    },
  );

  app.addHook("onRequest", async (req) => {
    logger.debug(`HTTP ${req.method} ${req.url}`);
  });

  try {
    const address = await app.listen({
      port: METRICS_PORT,
      host: METRICS_HOST,
    });

    logger.info(`Metrics server listening on ${address}`);
  } catch (err) {
    logger.error("Metrics server failed to start", err);
  }
}

/* -------------------------
   Main
-------------------------- */

async function main() {
  logger.info("Starting gateway...");

  if (!TOKEN) {
    throw new Error("Missing DISCORD_TOKEN");
  }

  const shards = await startShards(TOKEN);

  logger.info(`Started ${shards.length} shards`);

  startMetricsLoop(shards);

  await startMetricsServer();

  logger.info("Gateway fully started");
}

void main();
