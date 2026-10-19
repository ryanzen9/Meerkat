import type { ReviewSnapshotState } from '../../../shared/review';
import { reviewSnapshotSchema } from '../../../shared/review';
import { BridgeError } from '../errors';
import { ReviewJournal } from './reviews';

export interface ReviewStorage {
  read(sessionId: string): unknown;
  write(sessionId: string, state: ReviewSnapshotState | undefined): Promise<void>;
}

// Stored independently of the ephemeral model/provider session. A Host restart
// must not discard accepted findings or reopen an interrupted review as complete.
export class ReviewArchive {
  private readonly journals = new Map<string, ReviewJournal>();
  constructor(private readonly storage?: ReviewStorage) {}

  create(sessionId: string): ReviewJournal {
    const journal = this.journal(sessionId);
    this.journals.set(sessionId, journal);
    return journal;
  }

  get(sessionId: string): ReviewJournal {
    const active = this.journals.get(sessionId);
    if (active) return active;
    const saved = reviewSnapshotSchema.safeParse(this.storage?.read(sessionId));
    if (!saved.success || saved.data.runs.some((run) => run.sessionId !== sessionId))
      throw new BridgeError('review_not_found', 'Saved review not found.', 404);
    for (const run of saved.data.runs) {
      if (run.status !== 'running') continue;
      run.status = 'incomplete';
      run.summary = `审查已中断，已收录 ${run.issueCount} 条问题。`;
      run.unfinishedItems = ['Host 会话已结束，无法确认审查完成。'];
    }
    const journal = this.journal(sessionId, saved.data);
    this.journals.set(sessionId, journal);
    return journal;
  }

  async delete(sessionId: string): Promise<void> {
    await this.get(sessionId).erase(async () => {
      await this.storage?.write(sessionId, undefined);
    });
    this.journals.delete(sessionId);
  }

  private journal(sessionId: string, saved?: ReviewSnapshotState): ReviewJournal {
    return new ReviewJournal(
      this.storage ? (state) => this.storage!.write(sessionId, state) : undefined,
      saved,
    );
  }
}
