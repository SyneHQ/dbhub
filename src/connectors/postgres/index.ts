import pg from 'pg';
const { Pool } = pg;
import { Connector, ConnectorRegistry, DSNParser, QueryResult, TableColumn } from '../interface.js';

/**
 * PostgreSQL DSN Parser
 * Handles DSN strings like: postgres://user:password@localhost:5432/dbname?sslmode=disable
 */
class PostgresDSNParser implements DSNParser {
  parse(dsn: string): pg.PoolConfig {
    // Basic validation
    if (!this.isValidDSN(dsn)) {
      throw new Error(`Invalid PostgreSQL DSN: ${dsn}`);
    }

    try {
      // For PostgreSQL, we can actually pass the DSN directly to the Pool constructor
      // But we'll parse it here for consistency and to extract components if needed
      const url = new URL(dsn);
      
      const config: pg.PoolConfig = {
        host: url.hostname,
        port: url.port ? parseInt(url.port) : 5432,
        database: url.pathname.substring(1), // Remove leading '/'
        user: url.username,
        password: url.password,
      };
      
      // Handle query parameters (like sslmode, etc.)
      url.searchParams.forEach((value, key) => {
        if (key === 'sslmode') {
          config.ssl = value !== 'disable';
        }
        // Add other parameters as needed
      });
      
      return config;
    } catch (error) {
      throw new Error(`Failed to parse PostgreSQL DSN: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getSampleDSN(): string {
    return 'postgres://postgres:password@localhost:5432/postgres?sslmode=disable';
  }

  isValidDSN(dsn: string): boolean {
    try {
      const url = new URL(dsn);
      return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
    } catch (error) {
      return false;
    }
  }
}

/**
 * PostgreSQL Connector Implementation
 */
export class PostgresConnector implements Connector {
  id = 'postgres';
  name = 'PostgreSQL';
  dsnParser = new PostgresDSNParser();
  
  private pool: pg.Pool | null = null;

  async connect(dsn: string): Promise<void> {
    try {
      const config = this.dsnParser.parse(dsn);
      this.pool = new Pool(config);
      
      // Test the connection
      const client = await this.pool.connect();
      console.error("Successfully connected to PostgreSQL database");
      client.release();
    } catch (err) {
      console.error("Failed to connect to PostgreSQL database:", err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async getSchemas(): Promise<string[]> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }
    
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        ORDER BY schema_name
      `);
      
      return result.rows.map(row => row.schema_name);
    } finally {
      client.release();
    }
  }

  async getTables(schema?: string): Promise<string[]> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }
    
    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      // 'public' is the standard default schema in PostgreSQL databases
      const schemaToUse = schema || 'public';
      
      const result = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = $1
        ORDER BY table_name
      `, [schemaToUse]);
      
      return result.rows.map(row => row.table_name);
    } finally {
      client.release();
    }
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }
    
    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      const schemaToUse = schema || 'public';
      
      const result = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = $1 
          AND table_name = $2
        )
      `, [schemaToUse, tableName]);
      
      return result.rows[0].exists;
    } finally {
      client.release();
    }
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }
    
    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      const schemaToUse = schema || 'public';
      
      // Query to get all indexes for the table
      const result = await client.query(`
        SELECT 
          i.relname as index_name,
          array_agg(a.attname) as column_names,
          ix.indisunique as is_unique,
          ix.indisprimary as is_primary
        FROM 
          pg_class t,
          pg_class i,
          pg_index ix,
          pg_attribute a,
          pg_namespace ns
        WHERE 
          t.oid = ix.indrelid
          AND i.oid = ix.indexrelid
          AND a.attrelid = t.oid
          AND a.attnum = ANY(ix.indkey)
          AND t.relkind = 'r'
          AND t.relname = $1
          AND ns.oid = t.relnamespace
          AND ns.nspname = $2
        GROUP BY 
          i.relname, 
          ix.indisunique,
          ix.indisprimary
        ORDER BY 
          i.relname
      `, [tableName, schemaToUse]);
      
      return result.rows.map(row => ({
        index_name: row.index_name,
        column_names: row.column_names,
        is_unique: row.is_unique,
        is_primary: row.is_primary
      }));
    } finally {
      client.release();
    }
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }
    
    const client = await this.pool.connect();
    try {
      // In PostgreSQL, use 'public' as the default schema if none specified
      // Tables are created in the 'public' schema by default unless otherwise specified
      const schemaToUse = schema || 'public';
      
      // Get table columns
      const result = await client.query(`
        SELECT 
          column_name, 
          data_type, 
          is_nullable,
          column_default
        FROM information_schema.columns
        WHERE table_schema = $1
        AND table_name = $2
        ORDER BY ordinal_position
      `, [schemaToUse, tableName]);
      
      return result.rows;
    } finally {
      client.release();
    }
  }

  async executeQuery(query: string): Promise<QueryResult> {
    if (!this.pool) {
      throw new Error('Not connected to database');
    }
    
    const safetyCheck = this.validateQuery(query);
    if (!safetyCheck.isValid) {
      throw new Error(safetyCheck.message || "Query validation failed");
    }

    const client = await this.pool.connect();
    try {
      return await client.query(query);
    } finally {
      client.release();
    }
  }

  validateQuery(query: string): { isValid: boolean; message?: string } {
    // Basic check to prevent non-SELECT queries
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery.startsWith('select')) {
      return {
        isValid: false,
        message: "Only SELECT queries are allowed for security reasons."
      };
    }
    return { isValid: true };
  }
}

// Create and register the connector
const postgresConnector = new PostgresConnector();
ConnectorRegistry.register(postgresConnector);