/**
 * Logger único — cada `pino({ transport: "pino-pretty" })` registra um `process.on("exit")`;
 * vários módulos geravam MaxListenersExceededWarning (limite padrão 10).
 */
import pino from "pino";

const level = process.env.LOG_LEVEL || "info";
const usePretty =
  process.env.LOG_PRETTY !== "false" &&
  (process.env.NODE_ENV !== "production" || process.env.LOG_PRETTY === "true");

export const logger = usePretty
  ? pino({
      level,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      },
    })
  : pino({ level });

export default logger;
