/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as semver from 'semver';
import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import {
  DBSYSTEMVALUES_MYSQL,
  SEMATTRS_DB_NAME,
  SEMATTRS_DB_STATEMENT,
  SEMATTRS_DB_SYSTEM,
  SEMATTRS_DB_USER,
  SEMATTRS_NET_PEER_NAME,
  SEMATTRS_NET_PEER_PORT,
} from '@opentelemetry/semantic-conventions';
import * as testUtils from '@opentelemetry/contrib-test-utils';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import * as assert from 'assert';
import { MySQL2Instrumentation, MySQL2InstrumentationConfig } from '../src';

const LIB_VERSION = testUtils.getPackageVersion('mysql2');
const port = Number(process.env.MYSQL_PORT) || 33306;
const database = process.env.MYSQL_DATABASE || 'test_db';
const host = process.env.MYSQL_HOST || '127.0.0.1';
const user = process.env.MYSQL_USER || 'otel';
const password = process.env.MYSQL_PASSWORD || 'secret';
const rootPassword = process.env.MYSQL_ROOT_PASSWORD || 'rootpw';

const instrumentation = new MySQL2Instrumentation();
instrumentation.enable();
instrumentation.disable();

import * as mysqlTypes from 'mysql2';

interface Result extends mysqlTypes.RowDataPacket {
  solution: number;
}

describe('mysql2', () => {
  let contextManager: AsyncHooksContextManager;
  let connection: mysqlTypes.Connection;
  let rootConnection: mysqlTypes.Connection;
  let pool: mysqlTypes.Pool;
  let poolCluster: mysqlTypes.PoolCluster;
  const provider = new BasicTracerProvider();
  const testMysql = process.env.RUN_MYSQL_TESTS; // For CI: assumes local mysql db is already available
  const testMysqlLocally = process.env.RUN_MYSQL_TESTS_LOCAL; // For local: spins up local mysql db via docker
  const shouldTest = testMysql || testMysqlLocally; // Skips these tests if false (default)
  const memoryExporter = new InMemorySpanExporter();

  const getLastQueries = (count: number) =>
    new Promise<string[]>(res => {
      const queries: string[] = [];
      const query = rootConnection.query({
        sql: "SELECT * FROM mysql.general_log WHERE command_type = 'Query' ORDER BY event_time DESC LIMIT ? OFFSET 1",
        values: [count],
      });

      query.on('result', (row: { argument: string | Buffer }) => {
        if (typeof row.argument === 'string') {
          queries.push(row.argument);
        } else {
          queries.push(row.argument.toString('utf-8'));
        }
      });
      query.on('end', () => res(queries));
    });

  before(function (done) {
    if (!shouldTest) {
      // this.skip() workaround
      // https://github.com/mochajs/mocha/issues/2683#issuecomment-375629901
      this.test!.parent!.pending = true;
      this.skip();
    }
    provider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));
    rootConnection = mysqlTypes.createConnection({
      port,
      user: 'root',
      host,
      password: rootPassword,
      database,
    });
    if (testMysqlLocally) {
      testUtils.startDocker('mysql');
      // wait 15 seconds for docker container to start
      this.timeout(20000);
      setTimeout(done, 15000);
    } else {
      done();
    }
  });

  after(function (done) {
    rootConnection.end(() => {
      if (testMysqlLocally) {
        this.timeout(5000);
        testUtils.cleanUpDocker('mysql');
      }
      done();
    });
  });

  beforeEach(() => {
    instrumentation.disable();
    contextManager = new AsyncHooksContextManager().enable();
    context.setGlobalContextManager(contextManager);
    instrumentation.setTracerProvider(provider);
    instrumentation.enable();
    connection = mysqlTypes.createConnection({
      port,
      user,
      host,
      password,
      database,
    });
    pool = mysqlTypes.createPool({
      port,
      user,
      host,
      password,
      database,
    });
    poolCluster = mysqlTypes.createPoolCluster();
    // the implementation actually accepts ConnectionConfig as well,
    // but the types do not reflect that
    poolCluster.add('name', {
      port,
      user,
      host,
      password,
      database,
    });
  });

  afterEach(done => {
    context.disable();
    memoryExporter.reset();
    instrumentation.setConfig({});
    instrumentation.disable();
    connection.end(() => {
      pool.end(() => {
        if (isPoolClusterEndIgnoreCallback()) {
          poolCluster.end();
          done();
        } else {
          // PoolCluster.end types in the package are invalid
          // https://github.com/sidorares/node-mysql2/pull/1332
          (poolCluster as any).end(() => {
            done();
          });
        }
      });
    });
  });

  describe('when the query is a string', () => {
    it('should name the span accordingly ', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+1 as solution';
        const query = connection.query(sql);

        query.on('end', () => {
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans[0].name, 'SELECT');
          assert.strictEqual(spans[0].attributes[SEMATTRS_DB_STATEMENT], sql);
          done();
        });
      });
    });
  });

  describe('when the query is an object', () => {
    it('should name the span accordingly ', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+? as solution';
        const query = connection.query({ sql, values: [1] });

        query.on('end', () => {
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans[0].name, 'SELECT');
          assert.strictEqual(
            spans[0].attributes[SEMATTRS_DB_STATEMENT],
            query.sql
          );
          done();
        });
      });
    });
  });

  describe('#Connection.query', () => {
    it('should intercept connection.query(text: string)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+1 as solution';
        const query = connection.query<Result[]>(sql);
        let rows = 0;

        query.on('result', (row: mysqlTypes.RowDataPacket) => {
          assert.strictEqual(row.solution, 2);
          rows += 1;
        });

        query.on('end', () => {
          try {
            assert.strictEqual(rows, 1);
            const spans = memoryExporter.getFinishedSpans();
            assert.strictEqual(spans.length, 1);
            assertSpan(spans[0], sql);
          } catch (e) {
            done(e);
          }
          done();
        });
      });
    });

    it('should intercept connection.query(text: string, callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+1 as solution';
        connection.query(sql, (err, res: mysqlTypes.RowDataPacket[]) => {
          assert.ifError(err);
          assert.ok(res);
          assert.strictEqual(res[0].solution, 2);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql);
          done();
        });
      });
    });

    it('should intercept connection.query(text: options, callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+? as solution';
        connection.query(
          { sql, values: [1] },
          (err, res: mysqlTypes.RowDataPacket[]) => {
            assert.ifError(err);
            assert.ok(res);
            assert.strictEqual(res[0].solution, 2);
            const spans = memoryExporter.getFinishedSpans();
            assert.strictEqual(spans.length, 1);
            assertSpan(spans[0], sql, [1]);
            done();
          }
        );
      });
    });

    it('should intercept connection.query(text: options, values: [], callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+? as solution';
        connection.query(
          { sql },
          [1],
          (err, res: mysqlTypes.RowDataPacket[]) => {
            assert.ifError(err);
            assert.ok(res);
            assert.strictEqual(res[0].solution, 2);
            const spans = memoryExporter.getFinishedSpans();
            assert.strictEqual(spans.length, 1);
            assertSpan(spans[0], sql, [1]);
            done();
          }
        );
      });
    });

    it('should intercept connection.query(text: string, values: [], callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT ? as solution';
        connection.query(sql, [1], (err, res: mysqlTypes.RowDataPacket[]) => {
          assert.ifError(err);
          assert.ok(res);
          assert.strictEqual(res[0].solution, 1);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql, [1]);
          done();
        });
      });
    });

    it('should intercept connection.query(text: string, value: any, callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT ? as solution';
        connection.query(sql, 1, (err, res: mysqlTypes.RowDataPacket[]) => {
          assert.ifError(err);
          assert.ok(res);
          assert.strictEqual(res[0].solution, 1);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql, [1]);
          done();
        });
      });
    });

    it('should attach error messages to spans', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT ? as solution';
        connection.query(sql, (err, res) => {
          assert.ok(err);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql, undefined, err!.message);
          done();
        });
      });
    });

    it('should not add comment by default', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        connection.query('SELECT 1+1 as solution', () => {
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          getLastQueries(1).then(([query]) => {
            try {
              assert.doesNotMatch(query, /.*traceparent.*/);
              done();
            } catch (e) {
              done(e);
            }
          });
        });
      });
    });

    it('should not add comment when specified if existing block comment', done => {
      instrumentation.setConfig({
        addSqlCommenterCommentToQueries: true,
      } as any);
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        connection.query('SELECT 1+1 as solution /*block comment*/', () => {
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          getLastQueries(1).then(([query]) => {
            assert.doesNotMatch(query, /.*traceparent.*/);
            done();
          });
        });
      });
    });

    it('should not add comment when specified if existing line comment', done => {
      instrumentation.setConfig({
        addSqlCommenterCommentToQueries: true,
      } as any);
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        connection.query('SELECT 1+1 as solution -- line comment', () => {
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          getLastQueries(1).then(([query]) => {
            assert.doesNotMatch(query, /.*traceparent.*/);
            done();
          });
        });
      });
    });

    it('should add comment when specified if no existing comment', done => {
      instrumentation.setConfig({
        addSqlCommenterCommentToQueries: true,
      } as any);
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        connection.query('SELECT 1+1 as solution', () => {
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          getLastQueries(1).then(([query]) => {
            assert.match(query, /.*traceparent.*/);
            done();
          });
        });
      });
    });
  });

  describe('#Connection.execute', () => {
    it('should intercept connection.execute(text: string)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+1 as solution';
        const query = connection.execute<Result[]>(sql);
        let rows = 0;

        query.on('result', (row: mysqlTypes.RowDataPacket) => {
          assert.strictEqual(row.solution, 2);
          rows += 1;
        });

        query.on('end', () => {
          assert.strictEqual(rows, 1);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql);
          done();
        });
      });
    });

    it('should intercept connection.execute(text: string, callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+1 as solution';
        connection.execute(sql, (err, res: mysqlTypes.RowDataPacket[]) => {
          assert.ifError(err);
          assert.ok(res);
          assert.strictEqual(res[0].solution, 2);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql);
          done();
        });
      });
    });

    it('should intercept connection.execute(text: options, callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+? as solution';
        connection.execute(
          { sql, values: [1] },
          (err, res: mysqlTypes.RowDataPacket[]) => {
            assert.ifError(err);
            assert.ok(res);
            assert.strictEqual(res[0].solution, 2);
            const spans = memoryExporter.getFinishedSpans();
            assert.strictEqual(spans.length, 1);
            assertSpan(spans[0], sql, [1]);
            done();
          }
        );
      });
    });

    it('should intercept connection.execute(text: options, values: [], callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+? as solution';
        connection.execute(
          { sql },
          [1],
          (err, res: mysqlTypes.RowDataPacket[]) => {
            assert.ifError(err);
            assert.ok(res);
            assert.strictEqual(res[0].solution, 2);
            const spans = memoryExporter.getFinishedSpans();
            assert.strictEqual(spans.length, 1);
            assertSpan(spans[0], sql, [1]);
            done();
          }
        );
      });
    });

    it('should intercept connection.execute(text: string, values: [], callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+? as solution';
        connection.execute(sql, [1], (err, res: mysqlTypes.RowDataPacket[]) => {
          assert.ifError(err);
          assert.ok(res);
          assert.strictEqual(res[0].solution, 2);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql, [1]);
          done();
        });
      });
    });

    it('should intercept connection.execute(text: string, value: any, callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+? as solution';
        connection.execute(sql, [1], (err, res: mysqlTypes.RowDataPacket[]) => {
          assert.ifError(err);
          assert.ok(res);
          assert.strictEqual(res[0].solution, 2);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql, [1]);
          done();
        });
      });
    });

    it('should attach error messages to spans', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT ? as solution';
        connection.execute(sql, (err, res) => {
          assert.ok(err);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql, undefined, err!.message);
          done();
        });
      });
    });
  });

  describe('#Pool.query', () => {
    it('should intercept pool.query(text: string)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+1 as solution';
        const query = pool.query(sql);
        let rows = 0;

        query.on('result', (row: mysqlTypes.RowDataPacket) => {
          assert.strictEqual(row.solution, 2);
          rows += 1;
        });

        query.on('end', () => {
          assert.strictEqual(rows, 1);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql);
          done();
        });
      });
    });

    it('should intercept pool.getConnection().query(text: string)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+1 as solution';
        pool.getConnection((err, conn) => {
          const query = conn.query(sql);
          let rows = 0;

          query.on('result', (row: mysqlTypes.RowDataPacket) => {
            assert.strictEqual(row.solution, 2);
            rows += 1;
          });

          query.on('end', () => {
            assert.strictEqual(rows, 1);
            const spans = memoryExporter.getFinishedSpans();
            assert.strictEqual(spans.length, 1);
            assertSpan(spans[0], sql);
            done();
          });
        });
      });
    });

    it('should intercept pool.query(text: string, callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+1 as solution';
        pool.query(sql, (err, res: mysqlTypes.RowDataPacket[]) => {
          assert.ifError(err);
          assert.ok(res);
          assert.strictEqual(res[0].solution, 2);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql);
          done();
        });
      });
    });

    it('should intercept pool.getConnection().query(text: string, callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+1 as solution';
        pool.getConnection((err, conn) => {
          conn.query(sql, (err, res: mysqlTypes.RowDataPacket[]) => {
            assert.ifError(err);
            assert.ok(res);
            assert.strictEqual(res[0].solution, 2);
            const spans = memoryExporter.getFinishedSpans();
            assert.strictEqual(spans.length, 1);
            assertSpan(spans[0], sql);
            done();
          });
        });
      });
    });

    it('should intercept pool.query(text: options, callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+? as solution';
        pool.query(
          { sql, values: [1] },
          (err, res: mysqlTypes.RowDataPacket[]) => {
            assert.ifError(err);
            assert.ok(res);
            assert.strictEqual(res[0].solution, 2);
            const spans = memoryExporter.getFinishedSpans();
            assert.strictEqual(spans.length, 1);
            assertSpan(spans[0], sql, [1]);
            done();
          }
        );
      });
    });

    it('should intercept pool.query(text: options, values: [], callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+? as solution';
        pool.query({ sql }, [1], (err, res: mysqlTypes.RowDataPacket[]) => {
          assert.ifError(err);
          assert.ok(res);
          assert.strictEqual(res[0].solution, 2);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql, [1]);
          done();
        });
      });
    });

    it('should intercept pool.query(text: string, values: [], callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT ? as solution';
        pool.query(sql, [1], (err, res: mysqlTypes.RowDataPacket[]) => {
          assert.ifError(err);
          assert.ok(res);
          assert.strictEqual(res[0].solution, 1);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql, [1]);
          done();
        });
      });
    });

    it('should intercept pool.query(text: string, value: any, callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT ? as solution';
        pool.query(sql, 1, (err, res: mysqlTypes.RowDataPacket[]) => {
          assert.ifError(err);
          assert.ok(res);
          assert.strictEqual(res[0].solution, 1);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql, [1]);
          done();
        });
      });
    });

    it('should attach error messages to spans', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT ? as solution';
        pool.query(sql, (err, res) => {
          assert.ok(err);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql, undefined, err!.message);
          done();
        });
      });
    });

    it('should not add comment by default', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        pool.query('SELECT 1+1 as solution', () => {
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          getLastQueries(1).then(([query]) => {
            assert.doesNotMatch(query, /.*traceparent.*/);
            done();
          });
        });
      });
    });

    it('should not add comment when specified if existing block comment', done => {
      instrumentation.setConfig({
        addSqlCommenterCommentToQueries: true,
      } as any);
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        pool.query('SELECT 1+1 as solution /*block comment*/', () => {
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          getLastQueries(1).then(([query]) => {
            assert.doesNotMatch(query, /.*traceparent.*/);
            done();
          });
        });
      });
    });

    it('should not add comment when specified if existing line comment', done => {
      instrumentation.setConfig({
        addSqlCommenterCommentToQueries: true,
      } as any);
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        pool.query('SELECT 1+1 as solution -- line comment', () => {
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          getLastQueries(1).then(([query]) => {
            assert.doesNotMatch(query, /.*traceparent.*/);
            done();
          });
        });
      });
    });

    it('should add comment when specified if no existing comment', done => {
      instrumentation.setConfig({
        addSqlCommenterCommentToQueries: true,
      } as any);
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        pool.query('SELECT 1+1 as solution', () => {
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          getLastQueries(1).then(([query]) => {
            assert.match(query, /.*traceparent.*/);
            done();
          });
        });
      });
    });
  });

  describe('#Pool.execute', () => {
    it('should intercept pool.execute(text: string)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+1 as solution';
        pool.execute(sql, (err, row: mysqlTypes.RowDataPacket[]) => {
          assert(!err);
          assert.strictEqual(row[0].solution, 2);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql);
          done();
        });
      });
    });

    it('should intercept pool.getConnection().execute(text: string)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+1 as solution';
        pool.getConnection((err, conn) => {
          const query = conn.execute(sql);
          let rows = 0;

          query.on('result', (row: mysqlTypes.RowDataPacket) => {
            assert.strictEqual(row.solution, 2);
            rows += 1;
          });

          query.on('end', () => {
            assert.strictEqual(rows, 1);
            const spans = memoryExporter.getFinishedSpans();
            assert.strictEqual(spans.length, 1);
            assertSpan(spans[0], sql);
            done();
          });
        });
      });
    });

    it('should intercept pool.execute(text: string, callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+1 as solution';
        pool.execute(sql, (err, res: mysqlTypes.RowDataPacket[]) => {
          assert.ifError(err);
          assert.ok(res);
          assert.strictEqual(res[0].solution, 2);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql);
          done();
        });
      });
    });

    it('should intercept pool.getConnection().execute(text: string, callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+1 as solution';
        pool.getConnection((err, conn) => {
          conn.execute(sql, (err, res: mysqlTypes.RowDataPacket[]) => {
            assert.ifError(err);
            assert.ok(res);
            assert.strictEqual(res[0].solution, 2);
            const spans = memoryExporter.getFinishedSpans();
            assert.strictEqual(spans.length, 1);
            assertSpan(spans[0], sql);
            done();
          });
        });
      });
    });

    it('should intercept pool.execute(text: options, callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+? as solution';
        pool.execute(
          { sql, values: [1] },
          (err, res: mysqlTypes.RowDataPacket[]) => {
            assert.ifError(err);
            assert.ok(res);
            assert.strictEqual(res[0].solution, 2);
            const spans = memoryExporter.getFinishedSpans();
            assert.strictEqual(spans.length, 1);
            assertSpan(spans[0], sql);
            done();
          }
        );
      });
    });

    it('should intercept pool.execute(text: options, values: [], callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+? as solution';
        pool.execute({ sql }, [1], (err, res: mysqlTypes.RowDataPacket[]) => {
          assert.ifError(err);
          assert.ok(res);
          assert.strictEqual(res[0].solution, 2);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql, [1]);
          done();
        });
      });
    });

    it('should intercept pool.execute(text: string, values: [], callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+? as solution';
        pool.execute(sql, [1], (err, res: mysqlTypes.RowDataPacket[]) => {
          assert.ifError(err);
          assert.ok(res);
          assert.strictEqual(res[0].solution, 2);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql, [1]);
          done();
        });
      });
    });

    it('should intercept pool.execute(text: string, value: any, callback)', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT 1+? as solution';
        pool.execute(sql, [1], (err, res: mysqlTypes.RowDataPacket[]) => {
          assert.ifError(err);
          assert.ok(res);
          assert.strictEqual(res[0].solution, 2);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql, [1]);
          done();
        });
      });
    });

    it('should attach error messages to spans', done => {
      const span = provider.getTracer('default').startSpan('test span');
      context.with(trace.setSpan(context.active(), span), () => {
        const sql = 'SELECT ? as solution';
        pool.execute(sql, (err, res) => {
          assert.ok(err);
          const spans = memoryExporter.getFinishedSpans();
          assert.strictEqual(spans.length, 1);
          assertSpan(spans[0], sql, undefined, err!.message);
          done();
        });
      });
    });
  });

  describe('#PoolCluster', () => {
    it('should intercept poolClusterConnection.query(text: string)', done => {
      poolCluster.getConnection((err, poolClusterConnection) => {
        assert.ifError(err);
        const span = provider.getTracer('default').startSpan('test span');
        context.with(trace.setSpan(context.active(), span), () => {
          const sql = 'SELECT 1+1 as solution';
          const query = poolClusterConnection.query(sql);
          let rows = 0;

          query.on('result', (row: mysqlTypes.RowDataPacket) => {
            assert.strictEqual(row.solution, 2);
            rows += 1;
          });

          query.on('end', () => {
            assert.strictEqual(rows, 1);
            const spans = memoryExporter.getFinishedSpans();
            assert.strictEqual(spans.length, 1);
            assertSpan(spans[0], sql);
            done();
          });
        });
      });
    });

    it('should intercept poolClusterConnection.query(text: string, callback)', done => {
      poolCluster.getConnection((err, poolClusterConnection) => {
        assert.ifError(err);
        const span = provider.getTracer('default').startSpan('test span');
        context.with(trace.setSpan(context.active(), span), () => {
          const sql = 'SELECT 1+1 as solution';
          poolClusterConnection.query(
            sql,
            (err, res: mysqlTypes.RowDataPacket[]) => {
              assert.ifError(err);
              assert.ok(res);
              assert.strictEqual(res[0].solution, 2);
              const spans = memoryExporter.getFinishedSpans();
              assert.strictEqual(spans.length, 1);
              assertSpan(spans[0], sql);
              done();
            }
          );
        });
      });
    });

    it('should intercept poolClusterConnection.query(text: options, callback)', done => {
      poolCluster.getConnection((err, poolClusterConnection) => {
        assert.ifError(err);
        const span = provider.getTracer('default').startSpan('test span');
        context.with(trace.setSpan(context.active(), span), () => {
          const sql = 'SELECT 1+? as solution';
          poolClusterConnection.query(
            { sql, values: [1] },
            (err, res: mysqlTypes.RowDataPacket[]) => {
              assert.ifError(err);
              assert.ok(res);
              assert.strictEqual(res[0].solution, 2);
              const spans = memoryExporter.getFinishedSpans();
              assert.strictEqual(spans.length, 1);
              assertSpan(spans[0], sql, [1]);
              done();
            }
          );
        });
      });
    });

    it('should intercept poolClusterConnection.query(text: options, values: [], callback)', done => {
      poolCluster.getConnection((err, poolClusterConnection) => {
        assert.ifError(err);
        const span = provider.getTracer('default').startSpan('test span');
        context.with(trace.setSpan(context.active(), span), () => {
          const sql = 'SELECT 1+? as solution';
          poolClusterConnection.query(
            { sql },
            [1],
            (err, res: mysqlTypes.RowDataPacket[]) => {
              assert.ifError(err);
              assert.ok(res);
              assert.strictEqual(res[0].solution, 2);
              const spans = memoryExporter.getFinishedSpans();
              assert.strictEqual(spans.length, 1);
              assertSpan(spans[0], sql, [1]);
              done();
            }
          );
        });
      });
    });

    it('should intercept poolClusterConnection.query(text: string, values: [], callback)', done => {
      poolCluster.getConnection((err, poolClusterConnection) => {
        assert.ifError(err);
        const span = provider.getTracer('default').startSpan('test span');
        context.with(trace.setSpan(context.active(), span), () => {
          const sql = 'SELECT ? as solution';
          poolClusterConnection.query(
            sql,
            [1],
            (err, res: mysqlTypes.RowDataPacket[]) => {
              assert.ifError(err);
              assert.ok(res);
              assert.strictEqual(res[0].solution, 1);
              const spans = memoryExporter.getFinishedSpans();
              assert.strictEqual(spans.length, 1);
              assertSpan(spans[0], sql, [1]);
              done();
            }
          );
        });
      });
    });

    it('should intercept poolClusterConnection.query(text: string, value: any, callback)', done => {
      poolCluster.getConnection((err, poolClusterConnection) => {
        assert.ifError(err);
        const span = provider.getTracer('default').startSpan('test span');
        context.with(trace.setSpan(context.active(), span), () => {
          const sql = 'SELECT ? as solution';
          poolClusterConnection.query(
            sql,
            1,
            (err, res: mysqlTypes.RowDataPacket[]) => {
              assert.ifError(err);
              assert.ok(res);
              assert.strictEqual(res[0].solution, 1);
              const spans = memoryExporter.getFinishedSpans();
              assert.strictEqual(spans.length, 1);
              assertSpan(spans[0], sql, [1]);
              done();
            }
          );
        });
      });
    });

    it('should attach error messages to spans', done => {
      poolCluster.getConnection((err, poolClusterConnection) => {
        assert.ifError(err);
        const span = provider.getTracer('default').startSpan('test span');
        context.with(trace.setSpan(context.active(), span), () => {
          const sql = 'SELECT ? as solution';
          poolClusterConnection.query(sql, (err, res) => {
            assert.ok(err);
            const spans = memoryExporter.getFinishedSpans();
            assert.strictEqual(spans.length, 1);
            assertSpan(spans[0], sql, undefined, err!.message);
            done();
          });
        });
      });
    });

    it('should get connection by name', done => {
      poolCluster.getConnection('name', (err, poolClusterConnection) => {
        assert.ifError(err);
        const span = provider.getTracer('default').startSpan('test span');
        context.with(trace.setSpan(context.active(), span), () => {
          const sql = 'SELECT 1 as solution';
          poolClusterConnection.query(sql, (err, res) => {
            assert.ifError(err);
            const spans = memoryExporter.getFinishedSpans();
            assert.strictEqual(spans.length, 1);
            assertSpan(spans[0], sql);
            done();
          });
        });
      });
    });

    it('should get connection by name and selector', done => {
      poolCluster.getConnection(
        'name',
        'ORDER',
        (err, poolClusterConnection) => {
          assert.ifError(err);
          const sql = 'SELECT 1 as solution';
          poolClusterConnection.query(sql, (err, res) => {
            assert.ifError(err);
            const spans = memoryExporter.getFinishedSpans();
            assert.strictEqual(spans.length, 1);
            assertSpan(spans[0], sql);
            done();
          });
        }
      );
    });
  });

  describe('#responseHook', () => {
    const queryResultAttribute = 'query_result';

    describe('invalid response hook', () => {
      beforeEach(() => {
        const config: MySQL2InstrumentationConfig = {
          responseHook: (span, responseHookInfo) => {
            throw new Error('random failure!');
          },
        };
        instrumentation.setConfig(config);
      });

      it('should not affect the behavior of the query', done => {
        const span = provider.getTracer('default').startSpan('test span');
        context.with(trace.setSpan(context.active(), span), () => {
          const sql = 'SELECT 1+1 as solution';
          connection.query(sql, (err, res: mysqlTypes.RowDataPacket[]) => {
            assert.ifError(err);
            assert.ok(res);
            assert.strictEqual(res[0].solution, 2);
            done();
          });
        });
      });
    });

    describe('valid response hook', () => {
      beforeEach(() => {
        const config: MySQL2InstrumentationConfig = {
          responseHook: (span, responseHookInfo) => {
            span.setAttribute(
              queryResultAttribute,
              JSON.stringify(responseHookInfo.queryResults)
            );
          },
        };
        instrumentation.setConfig(config);
      });

      it('should extract data from responseHook - connection', done => {
        const span = provider.getTracer('default').startSpan('test span');
        context.with(trace.setSpan(context.active(), span), () => {
          const sql = 'SELECT 1+1 as solution';
          connection.query(sql, (err, res: mysqlTypes.RowDataPacket[]) => {
            assert.ifError(err);
            assert.ok(res);
            assert.strictEqual(res[0].solution, 2);
            const spans = memoryExporter.getFinishedSpans();
            assert.strictEqual(spans.length, 1);
            assertSpan(spans[0], sql);
            assert.strictEqual(
              spans[0].attributes[queryResultAttribute],
              JSON.stringify(res)
            );
            done();
          });
        });
      });

      it('should extract data from responseHook - pool', done => {
        const span = provider.getTracer('default').startSpan('test span');
        context.with(trace.setSpan(context.active(), span), () => {
          const sql = 'SELECT 1+1 as solution';
          pool.getConnection((err, conn) => {
            conn.query(sql, (err, res: mysqlTypes.RowDataPacket[]) => {
              assert.ifError(err);
              assert.ok(res);
              assert.strictEqual(res[0].solution, 2);
              const spans = memoryExporter.getFinishedSpans();
              assert.strictEqual(spans.length, 1);
              assertSpan(spans[0], sql);
              assert.strictEqual(
                spans[0].attributes[queryResultAttribute],
                JSON.stringify(res)
              );
              done();
            });
          });
        });
      });

      it('should extract data from responseHook - poolCluster', done => {
        poolCluster.getConnection((err, poolClusterConnection) => {
          assert.ifError(err);
          const span = provider.getTracer('default').startSpan('test span');
          context.with(trace.setSpan(context.active(), span), () => {
            const sql = 'SELECT 1+1 as solution';
            poolClusterConnection.query(
              sql,
              (err, res: mysqlTypes.RowDataPacket[]) => {
                assert.ifError(err);
                assert.ok(res);
                assert.strictEqual(res[0].solution, 2);
                const spans = memoryExporter.getFinishedSpans();
                assert.strictEqual(spans.length, 1);
                assertSpan(spans[0], sql);
                assert.strictEqual(
                  spans[0].attributes[queryResultAttribute],
                  JSON.stringify(res)
                );
                done();
              }
            );
          });
        });
      });
    });
  });
});

function assertSpan(
  span: ReadableSpan,
  sql: string,
  values?: any,
  errorMessage?: string
) {
  assert.strictEqual(span.attributes[SEMATTRS_DB_SYSTEM], DBSYSTEMVALUES_MYSQL);
  assert.strictEqual(span.attributes[SEMATTRS_DB_NAME], database);
  assert.strictEqual(span.attributes[SEMATTRS_NET_PEER_PORT], port);
  assert.strictEqual(span.attributes[SEMATTRS_NET_PEER_NAME], host);
  assert.strictEqual(span.attributes[SEMATTRS_DB_USER], user);
  assert.strictEqual(
    span.attributes[SEMATTRS_DB_STATEMENT],
    mysqlTypes.format(sql, values)
  );
  if (errorMessage) {
    assert.strictEqual(span.status.message, errorMessage);
    assert.strictEqual(span.status.code, SpanStatusCode.ERROR);
  }
}

function isPoolClusterEndIgnoreCallback() {
  // Since v2.2.0 `end` function respect callback
  // https://github.com/sidorares/node-mysql2/commit/1481015626e506754adc4308e5508356a3a03aa0
  return semver.lt(LIB_VERSION, '2.2.0');
}
