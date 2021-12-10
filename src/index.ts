import { createGatewayConnection } from "redis-discord-cache";
import winston from "winston";

const HOST = process.env.REDIS_HOST;
const PORT_string = process.env.REDIS_PORT;
const TOKEN = process.env.DISCORD_TOKEN;

if (!HOST || !PORT_string || !TOKEN) {
  throw new Error("Missing environment variables");
}
let PORT: number;
try {
  PORT = parseInt(PORT_string);
} catch (e) {
  throw new Error("Port must be a valid number");
}

let LOGGING_LEVEL = process.env.LOGGING_LEVEL;

if (!LOGGING_LEVEL) {
  LOGGING_LEVEL = "info";
}

createGatewayConnection({
  redis: { host: HOST, port: PORT },
  discord: {
    token: TOKEN,
    presence: {
      status: "online",
    },
  },
  logger: winston.createLogger({
    level: LOGGING_LEVEL,
    transports: [
      new winston.transports.Console({
        format: winston.format.simple(),
        handleExceptions: true,
      }),
    ],
    exitOnError: false,
  }),
});
