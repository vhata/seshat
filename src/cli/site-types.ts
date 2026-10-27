export interface SiteConfig {
  format: 1;
  accountId: string;
  workerName: string;
  origin: string;
  stage: "selected" | "bootstrap" | "credentials" | "configured";
  ownerId?: number;
  appSlug?: string;
  namespaceId?: string;
}

export interface CommandOptions {
  input?: string;
  interactive?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface SiteRuntime {
  root: string;
  configDir: string;
  readConfig(): Promise<SiteConfig | null>;
  writeConfig(config: SiteConfig): Promise<void>;
  readPrivate(name: string): Promise<unknown | null>;
  writePrivate(name: string, value: unknown): Promise<void>;
  removePrivate(name: string): Promise<void>;
  command(executable: string, args: string[], options?: CommandOptions): Promise<string>;
  wrangler(args: string[], options?: { accountId?: string; input?: string; interactive?: boolean }): Promise<string>;
  prompt(message: string, defaultValue?: string): Promise<string>;
  confirm(message: string, yes: boolean): Promise<void>;
  open(url: string): Promise<void>;
  request(url: string, init?: RequestInit): Promise<Response>;
  fetchJson(url: string): Promise<unknown>;
}

export interface SiteInspection {
  verified: true;
  origin: string;
  schemaVersion: number;
  build: { commit: string; dirty: false };
  version: { id: string; tag: string | null };
  deployment: { id: string; versions: { id: string; percentage: number }[] };
}
