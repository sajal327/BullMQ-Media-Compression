import pino from "pino";
import os from "os";

export const logger = pino({
  level: process.env.LOG_LEVEL || "debug",

  base: {
    service: "media-worker",
    pid: process.pid,
    hostname: os.hostname(),
  },

  timestamp: pino.stdTimeFunctions.isoTime,

  formatters: {
    level(label) {
      return { level: label.toUpperCase() };
    },
  },

  serializers: {
    err: pino.stdSerializers.err,
  },

  transport:
    process.env.NODE_ENV !== "production"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "yyyy-mm-dd HH:MM:ss.l",
            ignore: "pid,hostname",
            singleLine: false,
          },
        }
      : undefined,
});
