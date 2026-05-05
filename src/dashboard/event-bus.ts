/**
 * Simple in-process pub/sub for dashboard live event streaming.
 *
 * Other modules (orchestrator, discord, gmail) call `emitEvent()` AFTER they
 * call `logEvent()` to the DB. The dashboard's SSE handler subscribes via
 * `subscribe()` and pushes payloads to connected clients.
 *
 * This module is intentionally tiny and dependency-free.
 */

export interface BusEvent {
  ts: string;
  type: string;
  channel?: string;
  threadId?: string;
  summary: string;
  metaJson?: string;
}

export type EventListener = (ev: BusEvent) => void;

const listeners = new Set<EventListener>();

export function emitEvent(ev: BusEvent): void {
  // Defensive copy to avoid surprise mutation by listeners.
  const payload: BusEvent = {
    ts: ev.ts,
    type: ev.type,
    summary: ev.summary,
    ...(ev.channel !== undefined ? { channel: ev.channel } : {}),
    ...(ev.threadId !== undefined ? { threadId: ev.threadId } : {}),
    ...(ev.metaJson !== undefined ? { metaJson: ev.metaJson } : {}),
  };

  for (const listener of listeners) {
    try {
      listener(payload);
    } catch {
      // Listeners must not throw; if they do, swallow so other listeners still fire.
    }
  }
}

export function subscribe(listener: EventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For tests / shutdown. */
export function clearListeners(): void {
  listeners.clear();
}

/** For tests / debug. */
export function listenerCount(): number {
  return listeners.size;
}
