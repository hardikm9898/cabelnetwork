import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/db/migrator';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Connection URL (without database name) of the test PostgreSQL server. */
    pgServerUrl: string;
    /** Name of the migrated template database each test file clones. */
    pgTemplateDb: string;
  }
}

const TEMPLATE_DB = 'cablenet_template';
let container: StartedPostgreSqlContainer | undefined;

/**
 * Starts one PostgreSQL 18 container (or uses TEST_DATABASE_SERVER_URL, e.g. a CI service),
 * migrates a template database once, and shares its location with the test files.
 */
export default async function setup(project: TestProject) {
  let serverUrl = process.env.TEST_DATABASE_SERVER_URL;
  if (!serverUrl) {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('postgres')
      .withUsername('test')
      .withPassword('test')
      .start();
    serverUrl = `postgres://test:test@${container.getHost()}:${container.getPort()}`;
  }

  const { Client } = await import('pg');
  const admin = new Client({ connectionString: `${serverUrl}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await admin.end();

  await runMigrations(`${serverUrl}/${TEMPLATE_DB}`);

  project.provide('pgServerUrl', serverUrl);
  project.provide('pgTemplateDb', TEMPLATE_DB);

  return async () => {
    await container?.stop();
  };
}
