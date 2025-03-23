import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tablesResourceHandler } from './tables.js';
import { schemaResourceHandler } from './schema.js';
import { schemasResourceHandler } from './schemas.js';

// Export all resource handlers
export { tablesResourceHandler } from './tables.js';
export { schemaResourceHandler } from './schema.js';
export { schemasResourceHandler } from './schemas.js';

/**
 * Register all resource handlers with the MCP server
 */
export function registerResources(server: McpServer): void {
  // Resource for listing all schemas
  server.resource(
    "schemas",
    "db://schemas",
    schemasResourceHandler
  );

  // Allow listing tables within a specific schema
  server.resource(
    "tables_in_schema",
    new ResourceTemplate("db://schemas/{schemaName}/tables", { list: undefined }),
    tablesResourceHandler
  );

  // Resource for getting table structure within a specific database schema
  server.resource(
    "table_structure_in_schema",
    new ResourceTemplate("db://schemas/{schemaName}/schema/{tableName}", { list: undefined }),
    schemaResourceHandler
  );
}