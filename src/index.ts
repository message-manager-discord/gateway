// Runs gateway cache libary - and adds metrics
import { GatewayClient } from "redis-discord-cache";
import winston, { loggers } from "winston";
import promClient from "prom-client";
import fastify from "fastify";
import * as Sentry from "@sentry/node";

const HOST = process.env.REDIS_HOST;
const PORT_string = process.env.REDIS_PORT;
const TOKEN = process.env.DISCORD_TOKEN;
const METRICS_PORT_string = process.env.METRICS_PORT;
const METRICS_HOST = process.env.METRICS_HOST;
const METRICS_AUTH = process.env.METRICS_AUTH;

if (!PORT_string || !TOKEN) {
  throw new Error("Missing environment variables");
}
let PORT: number;
try {
  PORT = parseInt(PORT_string);
} catch (e) {
  throw new Error("Port must be a valid number");
}
let METRICS_PORT: number | undefined;
try {
  METRICS_PORT = METRICS_PORT_string
    ? parseInt(METRICS_PORT_string)
    : undefined;
} catch (e) {
  METRICS_PORT = undefined;
}

let LOGGING_LEVEL = process.env.LOGGING_LEVEL;

if (!LOGGING_LEVEL) {
  LOGGING_LEVEL = "info";
}

// Start sentry logging service
Sentry.init({
  dsn: process.env.SENTRY_DSN,
});

// Custom local Logger
const logger = winston.createLogger({
  level: LOGGING_LEVEL,
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
      handleExceptions: true,
    }),
  ],
  exitOnError: false,
});

// Capture any errors that happen when processing the packets (by the lib) and send to sentry
const handlePacketError = (error: unknown) => {
  Sentry.captureException(error);
};

// Metrics

const metricsPrefix = "discord_gateway_";
// Gauge for the number of guilds
const guildsGauge = new promClient.Gauge({
  name: `${metricsPrefix}guild_count`,
  help: "Number of guilds",
});
// Counter for the number of gateway events
const eventsCounter = new promClient.Counter({
  name: `${metricsPrefix}gateway_events_count`,
  help: "Number of gateway events",
  labelNames: ["name"],
});
// Counter for the number of redis commands
const redisCommandsCounter = new promClient.Counter({
  name: `${metricsPrefix}redis_commands_count`,
  help: "Number of redis commands",
  labelNames: ["name"],
});

// Handler for gateway events - metrics
const handleGatewayEvent = async ({ name }: { name: string }) => {
  eventsCounter.inc({ name });
};
// Handler for redis commands - metrics
const handleRedisCommand = async ({ name }: { name: string }) => {
  redisCommandsCounter.inc({ name });
};

// Sharding settings
const shardCount = 1;
const shardWaitConnect = 30;
const shards: GatewayClient[] = [];

// Spin up shards - at the moment this is just one shard
async function startShards(token: string) {
  for (let shardId = 0; shardId < shardCount; shardId++) {
    const shard = new GatewayClient({
      redis: { host: HOST, port: PORT },
      discord: {
        token,
        presence: {
          status: "online",
        },
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
}
startShards(TOKEN); // Start the shards with the bot's token

// Fetch guild count from client every 15 seconds and update metric gauge
const every15Seconds = async () => {
  // Check if client is connected and guild loaded
  let guildCount = 0;
  shards.forEach(async (shard) => {
    const shardGuildCount = await shard.getGuildCount();
    guildCount += shardGuildCount;
  });

  guildsGauge.set(guildCount);
  // TODO Prevent this from being 0 on startup (some kind of tracking state and guild counts to get when all guilds loaded )

  // Then call this function again in 15 seconds
  setTimeout(every15Seconds, 15 * 1000);
};

// First run of the function
every15Seconds();

if (METRICS_PORT && METRICS_HOST) {
  // If metrics port is defined create metrics server

  // Create web server for metrics endpoint
  const metricsServer = fastify();
  // Add metrics endpoint - authorization header must match METRICS_AUTH env variable
  metricsServer.get(
    "/metrics",
    {
      preHandler: async (request, reply) => {
        if (
          request.headers.authorization?.replace(/BEARER\s*/i, "") !==
          METRICS_AUTH
        ) {
          reply.code(401).send("Unauthorized");
        }
      },
    },
    async (request, reply) => {
      reply.type("text/plain").send(await promClient.register.metrics());
    }
  );
  metricsServer.addHook("onRequest", async (request, reply) => {
    logger.debug(
      `Received http request with method :${request.method} and path: ${request.url}`
    );
  });

  // Start metrics server
  logger.info(`Starting metrics server on port ${METRICS_PORT}`);
  metricsServer.listen(METRICS_PORT);
  metricsServer.listen(METRICS_PORT, METRICS_HOST, function (err, address) {
    // Seems to by typed incorrectly
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (err) {
      console.error(err);
      process.exit(1);
    }
    logger.info(`Server is now listening on ${address}`);
  });
}
