import { createSessionRegistry, type SessionRegistry } from "./registry";

const globalForBlackmagic = globalThis as typeof globalThis & {
  __blackmagicSessionRegistry?: SessionRegistry;
};

export function getSessionRegistry() {
  globalForBlackmagic.__blackmagicSessionRegistry ??= createSessionRegistry();
  return globalForBlackmagic.__blackmagicSessionRegistry;
}
