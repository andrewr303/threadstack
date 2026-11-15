export class DurableObject<Env = unknown> {
  protected ctx: {
    storage?: {
      get<T>(key: string): Promise<T | undefined>;
      put<T>(key: string, value: T): Promise<void>;
    };
  };
  protected env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = (ctx as typeof this.ctx) ?? {};
    this.env = env;
  }
}
