import { z } from 'zod';

export const logLevels = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof logLevels)[number];

const supplierUrl = z
  .url()
  .refine((value) => URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol));

const environmentSchema = z
  .object({
    PORT: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(65535))
      .default(3000),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(logLevels).default('info'),
    APP_MODE: z.enum(['api', 'worker', 'demo']).default('api'),
    TEMPORAL_ADDRESS: z
      .string()
      .trim()
      .regex(/^(?:[a-z\d.-]+|\[[a-f\d:]+\]):\d+$/i)
      .refine((value) => {
        const port = Number(value.slice(value.lastIndexOf(':') + 1));
        return port >= 1 && port <= 65535;
      })
      .default('127.0.0.1:7233'),
    TEMPORAL_NAMESPACE: z.string().trim().min(1).max(200).default('default'),
    TEMPORAL_TASK_QUEUE: z.string().trim().min(1).max(200).default('hotel-offers'),
    TEMPORAL_CLI_PATH: z.string().min(1).default('temporal'),
    REDIS_URL: z
      .url()
      .refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return ['redis:', 'rediss:'].includes(url.protocol) && url.hostname.length > 0;
      })
      .default('redis://127.0.0.1:6379'),
    ENABLE_INFRA_PROBE: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .default(false),
    SUPPLIER_A_URL: supplierUrl.optional(),
    SUPPLIER_B_URL: supplierUrl.optional(),
    SUPPLIER_A_DOWN: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .default(false),
    SUPPLIER_B_DOWN: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .default(false),
  })
  .superRefine((value, context) => {
    if (value.APP_MODE === 'demo' && !value.TEMPORAL_ADDRESS.startsWith('127.0.0.1:')) {
      context.addIssue({
        code: 'custom',
        path: ['TEMPORAL_ADDRESS'],
        message: 'Demo requires loopback',
      });
    }
  });

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    const variables = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid environment variables: ${variables.join(', ')}`);
  }

  return {
    port: result.data.PORT,
    environment: result.data.NODE_ENV,
    logLevel: result.data.LOG_LEVEL,
    mode: result.data.APP_MODE,
    temporalAddress: result.data.TEMPORAL_ADDRESS,
    namespace: result.data.TEMPORAL_NAMESPACE,
    taskQueue: result.data.TEMPORAL_TASK_QUEUE,
    temporalCliPath: result.data.TEMPORAL_CLI_PATH,
    redisUrl: result.data.REDIS_URL,
    enableInfraProbe: result.data.ENABLE_INFRA_PROBE,
    supplierADown: result.data.SUPPLIER_A_DOWN,
    supplierBDown: result.data.SUPPLIER_B_DOWN,
    supplierAUrl:
      result.data.SUPPLIER_A_URL ?? `http://127.0.0.1:${result.data.PORT}/supplierA/hotels`,
    supplierBUrl:
      result.data.SUPPLIER_B_URL ?? `http://127.0.0.1:${result.data.PORT}/supplierB/hotels`,
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
