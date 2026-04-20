import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ledgerEnvelopeSchema, paperLedgerEventSchema, type LedgerEnvelope, type PaperLedgerEvent } from './schemas.js';
import { projectLedgerState, type LedgerProjection } from './projection.js';

export type JsonlLedgerOptions = {
  directory: string;
  filename?: string;
  fsyncEachAppend?: boolean;
  clock?: () => Date;
};

export class JsonlLedger {
  readonly filePath: string;

  private readonly fsyncEachAppend: boolean;
  private readonly clock: () => Date;
  private initPromise: Promise<void> | null = null;
  private appendChain: Promise<void> = Promise.resolve();
  private nextSequence = 0;

  constructor(options: JsonlLedgerOptions) {
    this.filePath = join(options.directory, options.filename ?? 'paper-ledger.jsonl');
    this.fsyncEachAppend = options.fsyncEachAppend ?? true;
    this.clock = options.clock ?? (() => new Date());
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    await this.initPromise;
  }

  async append(eventOrEvents: PaperLedgerEvent | readonly PaperLedgerEvent[]): Promise<LedgerEnvelope[]> {
    const events = Array.isArray(eventOrEvents) ? [...eventOrEvents] : [eventOrEvents];
    if (events.length === 0) {
      return [];
    }

    await this.init();

    const task = this.appendChain.then(async () => this.doAppend(events));
    this.appendChain = task.then(() => undefined, () => undefined);
    return task;
  }

  async readAll(): Promise<LedgerEnvelope[]> {
    await this.init();
    return this.readAllInternal();
  }

  async readProjection(): Promise<LedgerProjection> {
    return projectLedgerState(await this.readAll());
  }

  static createEventId(prefix = 'evt'): string {
    return `${prefix}_${randomUUID()}`;
  }

  private async doInit(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const envelopes = await this.readAllInternal();
      this.nextSequence = envelopes.at(-1)?.sequence ?? 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        throw error;
      }
      await writeFile(this.filePath, '', 'utf8');
      this.nextSequence = 0;
    }
  }

  private async doAppend(events: readonly PaperLedgerEvent[]): Promise<LedgerEnvelope[]> {
    const appendedAt = this.clock().toISOString();
    const envelopes = events.map((input, index) => {
      const event = paperLedgerEventSchema.parse(input);
      return ledgerEnvelopeSchema.parse({
        sequence: this.nextSequence + index + 1,
        appendedAt,
        event
      });
    });

    const serialized = `${envelopes.map((envelope) => JSON.stringify(envelope)).join('\n')}\n`;
    const handle = await open(this.filePath, 'a');

    try {
      await handle.writeFile(serialized, 'utf8');
      if (this.fsyncEachAppend) {
        await handle.sync();
      }
    } finally {
      await handle.close();
    }

    this.nextSequence = envelopes.at(-1)?.sequence ?? this.nextSequence;
    return envelopes;
  }

  private async readAllInternal(): Promise<LedgerEnvelope[]> {
    const raw = await readFile(this.filePath, 'utf8');
    if (raw.trim().length === 0) {
      return [];
    }

    const envelopes: LedgerEnvelope[] = [];
    const lines = raw.split('\n');

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Ledger file ${this.filePath} contains invalid JSON on line ${index + 1}: ${error instanceof Error ? error.message : 'unknown parse error'}`
        );
      }

      try {
        envelopes.push(ledgerEnvelopeSchema.parse(parsed));
      } catch (error) {
        throw new Error(
          `Ledger file ${this.filePath} contains an invalid envelope on line ${index + 1}: ${error instanceof Error ? error.message : 'unknown schema error'}`
        );
      }
    }

    return envelopes;
  }
}
