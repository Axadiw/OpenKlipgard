import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { fileMetadata } from './db/schema/events.js';

describe('file_metadata indexes declared in the Drizzle schema', () => {
  const config = getTableConfig(fileMetadata);
  const byName = (name: string) => config.indexes.find((i) => i.config.name === name);

  it('DATA-056: every index that supports behaviour is declared, so db:generate cannot drop it', () => {
    for (const name of [
      'idx_file_metadata_owner_uploaded',
      'idx_file_metadata_owner_state_pending',
      'idx_file_metadata_redrive',
      'idx_file_metadata_unrecognized_retry',
    ]) {
      expect(byName(name), name).toBeDefined();
    }
  });

  it('DATA-056: idx_file_metadata_unrecognized_retry matches migration 0010 (column and partial predicate)', () => {
    const idx = byName('idx_file_metadata_unrecognized_retry')!;
    expect(idx.config.columns.map((c: any) => c.name)).toEqual(['next_retry_at']);
    const where = new PgDialect().sqlToQuery(idx.config.where!).sql.replace(/"file_metadata"\./g, '');
    expect(where).toBe(`"processing_state" = 'unrecognized' AND "next_retry_at" IS NOT NULL`);

    const migration = readFileSync(join(__dirname, 'db', 'migrations', '0010_unrecognized_retry_index.sql'), 'utf8');
    expect(migration).toContain('CREATE INDEX idx_file_metadata_unrecognized_retry');
    expect(migration).toContain('ON file_metadata(next_retry_at)');
    expect(migration).toContain(`WHERE processing_state = 'unrecognized' AND next_retry_at IS NOT NULL`);
  });
});
