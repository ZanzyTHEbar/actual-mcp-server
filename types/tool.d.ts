import { ZodTypeAny } from 'zod';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  call: (args: any, meta?: any) => Promise<any>;
}
