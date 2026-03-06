import { z } from 'zod';

export const configSchema = z.object({
  ACTUAL_SERVER_URL: z.string().url(),
  ACTUAL_PASSWORD: z.string().default(''),
  ACTUAL_BUDGET_SYNC_ID: z.string().min(1),
  ACTUAL_BUDGET_PASSWORD: z.string().optional(),
  MCP_BRIDGE_DATA_DIR: z.string().default('./actual-data'),
  MCP_BRIDGE_PORT: z.string().default('3000'),
  MCP_TRANSPORT_MODE: z.enum(['--http', '--sse']).default('--http'),
  MCP_SSE_AUTHORIZATION: z.string().optional(),
  MCP_ENABLE_HTTPS: z.string().optional().transform(val => val === 'true'),
  MCP_HTTPS_CERT: z.string().optional(),
  MCP_HTTPS_KEY: z.string().optional(),
  MAX_CONCURRENT_SESSIONS: z.string().default('5').transform(val => parseInt(val, 10)),
  SESSION_IDLE_TIMEOUT_MINUTES: z.string().default('10').transform(val => parseInt(val, 10)),
  SESSION_TOOL_TIMEOUT_MS: z.string().default('45000').transform(val => parseInt(val, 10)),
  MCP_SESSION_CACHE_CLEANUP: z.string().optional().default('true').transform(val => val === 'true'),

  // Search & caching
  SEARCH_ENABLED: z.string().optional().default('true').transform(val => val === 'true'),
  SEARCH_EMBEDDING_MODEL: z.string().optional().default('Xenova/all-MiniLM-L6-v2'),
  SEARCH_INDEX_DIR: z.string().optional(), // defaults to MCP_BRIDGE_DATA_DIR at runtime
  CACHE_DEFAULT_TTL_MS: z.string().optional().default('300000').transform(val => parseInt(val, 10)), // 5 min

  // Authentication
  AUTH_PROVIDER: z.enum(['none', 'oidc', 'ldap']).optional().default('none'),
  // OIDC settings
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_AUDIENCE: z.string().optional(),
  OIDC_RESOURCE: z.string().optional(),
  OIDC_SCOPES: z.string().optional().transform(val =>
    val ? val.split(',').map(scope => scope.trim()).filter(Boolean) : []
  ),
  // LDAP settings
  LDAP_URL: z.string().optional(),
  LDAP_BIND_DN: z.string().optional(),
  LDAP_BIND_PASSWORD: z.string().optional(),
  LDAP_SEARCH_BASE: z.string().optional(),
  LDAP_SEARCH_FILTER: z.string().optional().default('(uid={{username}})'),
  LDAP_GROUP_SEARCH_BASE: z.string().optional(),
  LDAP_GROUP_SEARCH_FILTER: z.string().optional().default('(member={{dn}})'),
  // Budget access control (JSON map: {"user@example.com": ["budget-sync-id-1"]})
  AUTH_BUDGET_ACL: z.string().optional(),

  // Embedding provider
  EMBEDDING_PROVIDER: z.enum(['local', 'ollama', 'openai']).optional().default('local'),
  EMBEDDING_MODEL: z.string().optional(), // provider-specific model name override
  EMBEDDING_DIMENSIONS: z.string().optional().transform(val => val ? parseInt(val, 10) : undefined),
  OLLAMA_HOST: z.string().optional().default('http://localhost'),
  OLLAMA_PORT: z.string().optional().default('11434'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional().default('https://api.openai.com'),
});

export type Config = z.infer<typeof configSchema>;

function getConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid or missing environment variables:', result.error.format());
    process.exit(1);
  }
  return result.data;
}

const config = getConfig();
export default config;
