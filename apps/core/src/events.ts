import type { CoreEvent } from "@homebase/shared";

/**
 * How parts of the core tell the screen what is happening. Publishers do
 * not know who listens; a listener that fails never breaks a publisher.
 */
export class EventBus {
  private listeners = new Set<(event: CoreEvent) => void>();

  subscribe(listener: (event: CoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: CoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a broken connection is that listener's problem
      }
    }
  }
}
