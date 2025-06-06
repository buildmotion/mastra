import { createClient } from '@libsql/client';
import type { Client as TursoClient, InValue } from '@libsql/client';

import { parseSqlIdentifier } from '@mastra/core/utils';
import { MastraVector } from '@mastra/core/vector';
import type {
  IndexStats,
  QueryResult,
  QueryVectorParams,
  CreateIndexParams,
  UpsertVectorParams,
  DescribeIndexParams,
  DeleteIndexParams,
  DeleteVectorParams,
  UpdateVectorParams,
} from '@mastra/core/vector';
import type { VectorFilter } from '@mastra/core/vector/filter';
import { LibSQLFilterTranslator } from './filter';
import { buildFilterQuery } from './sql-builder';

interface LibSQLQueryParams extends QueryVectorParams {
  minScore?: number;
}

export class LibSQLVector extends MastraVector {
  private turso: TursoClient;

  constructor({
    connectionUrl,
    authToken,
    syncUrl,
    syncInterval,
  }: {
    connectionUrl: string;
    authToken?: string;
    syncUrl?: string;
    syncInterval?: number;
  }) {
    super();

    this.turso = createClient({
      url: connectionUrl,
      syncUrl: syncUrl,
      authToken,
      syncInterval,
    });

    if (connectionUrl.includes(`file:`) || connectionUrl.includes(`:memory:`)) {
      void this.turso.execute({
        sql: 'PRAGMA journal_mode=WAL;',
        args: {},
      });
    }
  }

  transformFilter(filter?: VectorFilter) {
    const translator = new LibSQLFilterTranslator();
    return translator.translate(filter);
  }

  async query({
    indexName,
    queryVector,
    topK = 10,
    filter,
    includeVector = false,
    minScore = 0,
  }: LibSQLQueryParams): Promise<QueryResult[]> {
    try {
      if (!Number.isInteger(topK) || topK <= 0) {
        throw new Error('topK must be a positive integer');
      }
      if (!Array.isArray(queryVector) || !queryVector.every(x => typeof x === 'number' && Number.isFinite(x))) {
        throw new Error('queryVector must be an array of finite numbers');
      }

      const parsedIndexName = parseSqlIdentifier(indexName, 'index name');

      const vectorStr = `[${queryVector.join(',')}]`;

      const translatedFilter = this.transformFilter(filter);
      const { sql: filterQuery, values: filterValues } = buildFilterQuery(translatedFilter);
      filterValues.push(minScore);
      filterValues.push(topK);

      const query = `
        WITH vector_scores AS (
          SELECT
            vector_id as id,
            (1-vector_distance_cos(embedding, '${vectorStr}')) as score,
            metadata
            ${includeVector ? ', vector_extract(embedding) as embedding' : ''}
          FROM ${parsedIndexName}
          ${filterQuery}
        )
        SELECT *
        FROM vector_scores
        WHERE score > ?
        ORDER BY score DESC
        LIMIT ?`;

      const result = await this.turso.execute({
        sql: query,
        args: filterValues,
      });

      return result.rows.map(({ id, score, metadata, embedding }) => ({
        id: id as string,
        score: score as number,
        metadata: JSON.parse((metadata as string) ?? '{}'),
        ...(includeVector && embedding && { vector: JSON.parse(embedding as string) }),
      }));
    } finally {
      // client.release()
    }
  }

  async upsert({ indexName, vectors, metadata, ids }: UpsertVectorParams): Promise<string[]> {
    const tx = await this.turso.transaction('write');

    try {
      const parsedIndexName = parseSqlIdentifier(indexName, 'index name');
      const vectorIds = ids || vectors.map(() => crypto.randomUUID());

      for (let i = 0; i < vectors.length; i++) {
        const query = `
          INSERT INTO ${parsedIndexName} (vector_id, embedding, metadata)
          VALUES (?, vector32(?), ?)
          ON CONFLICT(vector_id) DO UPDATE SET
            embedding = vector32(?),
            metadata = ?
        `;

        // console.log('INSERTQ', query, [
        //   vectorIds[i] as InValue,
        //   JSON.stringify(vectors[i]),
        //   JSON.stringify(metadata?.[i] || {}),
        //   JSON.stringify(vectors[i]),
        //   JSON.stringify(metadata?.[i] || {}),
        // ]);
        await tx.execute({
          sql: query,
          // @ts-ignore
          args: [
            vectorIds[i] as InValue,
            JSON.stringify(vectors[i]),
            JSON.stringify(metadata?.[i] || {}),
            JSON.stringify(vectors[i]),
            JSON.stringify(metadata?.[i] || {}),
          ],
        });
      }

      await tx.commit();
      return vectorIds;
    } catch (error) {
      await tx.rollback();
      if (error instanceof Error && error.message?.includes('dimensions are different')) {
        const match = error.message.match(/dimensions are different: (\d+) != (\d+)/);
        if (match) {
          const [, actual, expected] = match;
          throw new Error(
            `Vector dimension mismatch: Index "${indexName}" expects ${expected} dimensions but got ${actual} dimensions. ` +
              `Either use a matching embedding model or delete and recreate the index with the new dimension.`,
          );
        }
      }
      throw error;
    }
  }

  async createIndex({ indexName, dimension }: CreateIndexParams): Promise<void> {
    try {
      // Validate inputs
      if (!Number.isInteger(dimension) || dimension <= 0) {
        throw new Error('Dimension must be a positive integer');
      }
      const parsedIndexName = parseSqlIdentifier(indexName, 'index name');

      // Create the table with explicit schema
      await this.turso.execute({
        sql: `
        CREATE TABLE IF NOT EXISTS ${parsedIndexName} (
          id SERIAL PRIMARY KEY,
          vector_id TEXT UNIQUE NOT NULL,
          embedding F32_BLOB(${dimension}),
          metadata TEXT DEFAULT '{}'
        );
      `,
        args: [],
      });

      await this.turso.execute({
        sql: `
        CREATE INDEX IF NOT EXISTS ${parsedIndexName}_vector_idx
        ON ${parsedIndexName} (libsql_vector_idx(embedding))
      `,
        args: [],
      });
    } catch (error: any) {
      console.error('Failed to create vector table:', error);
      throw error;
    } finally {
      // client.release()
    }
  }

  async deleteIndex({ indexName }: DeleteIndexParams): Promise<void> {
    try {
      const parsedIndexName = parseSqlIdentifier(indexName, 'index name');
      // Drop the table
      await this.turso.execute({
        sql: `DROP TABLE IF EXISTS ${parsedIndexName}`,
        args: [],
      });
    } catch (error: any) {
      console.error('Failed to delete vector table:', error);
      throw new Error(`Failed to delete vector table: ${error.message}`);
    } finally {
      // client.release()
    }
  }

  async listIndexes(): Promise<string[]> {
    try {
      const vectorTablesQuery = `
        SELECT name FROM sqlite_master 
        WHERE type='table' 
        AND sql LIKE '%F32_BLOB%';
      `;
      const result = await this.turso.execute({
        sql: vectorTablesQuery,
        args: [],
      });
      return result.rows.map(row => row.name as string);
    } catch (error: any) {
      throw new Error(`Failed to list vector tables: ${error.message}`);
    }
  }

  /**
   * Retrieves statistics about a vector index.
   *
   * @param {string} indexName - The name of the index to describe
   * @returns A promise that resolves to the index statistics including dimension, count and metric
   */
  async describeIndex({ indexName }: DescribeIndexParams): Promise<IndexStats> {
    try {
      const parsedIndexName = parseSqlIdentifier(indexName, 'index name');
      // Get table info including column info
      const tableInfoQuery = `
        SELECT sql 
        FROM sqlite_master 
        WHERE type='table' 
        AND name = ?;
      `;
      const tableInfo = await this.turso.execute({
        sql: tableInfoQuery,
        args: [parsedIndexName],
      });

      if (!tableInfo.rows[0]?.sql) {
        throw new Error(`Table ${parsedIndexName} not found`);
      }

      // Extract dimension from F32_BLOB definition
      const dimension = parseInt((tableInfo.rows[0].sql as string).match(/F32_BLOB\((\d+)\)/)?.[1] || '0');

      // Get row count
      const countQuery = `
        SELECT COUNT(*) as count
        FROM ${parsedIndexName};
      `;
      const countResult = await this.turso.execute({
        sql: countQuery,
        args: [],
      });

      // LibSQL only supports cosine similarity currently
      const metric: 'cosine' | 'euclidean' | 'dotproduct' = 'cosine';

      return {
        dimension,
        count: (countResult?.rows?.[0]?.count as number) ?? 0,
        metric,
      };
    } catch (e: any) {
      throw new Error(`Failed to describe vector table: ${e.message}`);
    }
  }

  /**
   * Updates a vector by its ID with the provided vector and/or metadata.
   *
   * @param indexName - The name of the index containing the vector.
   * @param id - The ID of the vector to update.
   * @param update - An object containing the vector and/or metadata to update.
   * @param update.vector - An optional array of numbers representing the new vector.
   * @param update.metadata - An optional record containing the new metadata.
   * @returns A promise that resolves when the update is complete.
   * @throws Will throw an error if no updates are provided or if the update operation fails.
   */
  async updateVector({ indexName, id, update }: UpdateVectorParams): Promise<void> {
    try {
      const parsedIndexName = parseSqlIdentifier(indexName, 'index name');
      const updates = [];
      const args: InValue[] = [];

      if (update.vector) {
        updates.push('embedding = vector32(?)');
        args.push(JSON.stringify(update.vector));
      }

      if (update.metadata) {
        updates.push('metadata = ?');
        args.push(JSON.stringify(update.metadata));
      }

      if (updates.length === 0) {
        throw new Error('No updates provided');
      }

      args.push(id);

      const query = `
        UPDATE ${parsedIndexName}
        SET ${updates.join(', ')}
        WHERE vector_id = ?;
      `;

      await this.turso.execute({
        sql: query,
        args,
      });
    } catch (error: any) {
      throw new Error(`Failed to update vector by id: ${id} for index: ${indexName}: ${error.message}`);
    }
  }

  /**
   * Deletes a vector by its ID.
   * @param indexName - The name of the index containing the vector.
   * @param id - The ID of the vector to delete.
   * @returns A promise that resolves when the deletion is complete.
   * @throws Will throw an error if the deletion operation fails.
   */
  async deleteVector({ indexName, id }: DeleteVectorParams): Promise<void> {
    try {
      const parsedIndexName = parseSqlIdentifier(indexName, 'index name');
      await this.turso.execute({
        sql: `DELETE FROM ${parsedIndexName} WHERE vector_id = ?`,
        args: [id],
      });
    } catch (error: any) {
      throw new Error(`Failed to delete vector by id: ${id} for index: ${indexName}: ${error.message}`);
    }
  }

  async truncateIndex({ indexName }: DeleteIndexParams): Promise<void> {
    await this.turso.execute({
      sql: `DELETE FROM ${parseSqlIdentifier(indexName, 'index name')}`,
      args: [],
    });
  }
}
