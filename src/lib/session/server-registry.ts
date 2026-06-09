import { createSessionStoreFromEnvironment, type SessionStore } from "./store";

const globalForBlackmagic = globalThis as typeof globalThis & {
  __blackmagicSessionStore?: SessionStore;
};

export function getSessionStore() {
  globalForBlackmagic.__blackmagicSessionStore ??=
    createSessionStoreFromEnvironment();
  return globalForBlackmagic.__blackmagicSessionStore;
}
