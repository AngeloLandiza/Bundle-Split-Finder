// Only what the specs call inside the browser; the code runs there, not in Node.
declare const chrome: {
  runtime: { sendMessage(message: unknown): Promise<any> };
  storage: { local: { set(items: Record<string, unknown>): Promise<void> } };
  tabs: { query(q: object): Promise<{ url?: string; pendingUrl?: string }[]> };
  alarms: { get(name: string): Promise<{ periodInMinutes?: number } | undefined> };
};
