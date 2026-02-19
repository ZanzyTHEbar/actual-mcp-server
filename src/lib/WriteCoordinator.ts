type PendingRequest = {
  keys: string[];
  resolve: (release: () => void) => void;
};

export class WriteCoordinator {
  private locked = new Set<string>();
  private queue: PendingRequest[] = [];
  private processing = false;

  async acquire(keys: string[]): Promise<() => void> {
    const normalized = keys.length ? keys : ['write:global'];
    return new Promise((resolve) => {
      this.queue.push({ keys: Array.from(new Set(normalized)).sort(), resolve });
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.processing) return;
    this.processing = true;

    try {
      let progress = true;
      while (progress) {
        progress = false;
        for (let i = 0; i < this.queue.length; ) {
          const req = this.queue[i];
          const canAcquire = req.keys.every((k) => !this.locked.has(k));
          if (!canAcquire) {
            i += 1;
            continue;
          }
          for (const k of req.keys) this.locked.add(k);
          this.queue.splice(i, 1);
          req.resolve(() => this.release(req.keys));
          progress = true;
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private release(keys: string[]): void {
    for (const k of keys) this.locked.delete(k);
    this.processQueue();
  }
}
