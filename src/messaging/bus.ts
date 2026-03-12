/**
 * Kernel Message Bus — in-memory subscription registry.
 *
 * Tracks which modules subscribe to which topics.
 * The kernel forwards published messages to subscribers immediately via IPC.
 * No persistence, no queue, no retry — fire-and-forget.
 * Persistence is a module-level concern.
 */

export class MessageBus {
  /** topic → set of subscribed module IDs */
  private subscriptions = new Map<string, Set<string>>();

  // ─── Subscriptions ────────────────────────────────────────

  subscribe(moduleId: string, topics: string[]): void {
    for (const topic of topics) {
      if (!this.subscriptions.has(topic)) {
        this.subscriptions.set(topic, new Set());
      }
      this.subscriptions.get(topic)!.add(moduleId);
    }
  }

  unsubscribe(moduleId: string): void {
    for (const subscribers of this.subscriptions.values()) {
      subscribers.delete(moduleId);
    }
  }

  // ─── Publishing ───────────────────────────────────────────

  /**
   * Get subscriber module IDs for a topic (excluding sender).
   */
  getSubscribers(topic: string, excludeModuleId?: string): string[] {
    const subscribers = this.subscriptions.get(topic);
    if (!subscribers) return [];
    const result = [...subscribers];
    return excludeModuleId ? result.filter(id => id !== excludeModuleId) : result;
  }

  // ─── Cleanup ──────────────────────────────────────────────

  async close(): Promise<void> {
    this.subscriptions.clear();
  }
}
