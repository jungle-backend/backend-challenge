import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WagerService } from '../services/wager.service';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly wagers: WagerService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.runBatch(), 1000);
    void this.runBatch();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  private async runBatch(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.wagers.retryPendingReferences();
    } catch {
      console.error(JSON.stringify({ event: 'pending_reference_retry_failed' }));
    } finally {
      this.running = false;
    }
  }
}